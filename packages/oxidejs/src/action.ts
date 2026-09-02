import * as Effect from "effect/Effect";
import type * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as Registry from "effect/unstable/reactivity/AtomRegistry";

export const ACTION_CALL = Symbol.for("ilha.actionCall");
const ACTION_KEY = Symbol.for("oxidejs.actionKey");

const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => AsyncGenerator;

type CallOptions = { signal?: AbortSignal };

type PackArgs<Args extends unknown[]> = Args extends []
  ? void
  : Args extends [infer Head]
    ? Head
    : Args;

let defaultRegistry: Registry.AtomRegistry | undefined;

function registry(): Registry.AtomRegistry {
  return (defaultRegistry ??= Registry.make());
}

function isAsyncGeneratorFunction(fn: unknown): fn is (...args: unknown[]) => AsyncGenerator {
  return typeof fn === "function" && fn instanceof AsyncGeneratorFunction;
}

function splitCallOptions<Args extends unknown[]>(
  args: Args | [...Args, CallOptions],
): { args: Args; options?: CallOptions } {
  if (args.length === 0) return { args: [] as unknown as Args };
  const last = args[args.length - 1];
  if (
    last &&
    typeof last === "object" &&
    "signal" in last &&
    (last as CallOptions).signal instanceof AbortSignal &&
    Object.keys(last).length === 1
  ) {
    return { args: args.slice(0, -1) as Args, options: last as CallOptions };
  }
  return { args: args as Args };
}

function packArgs<Args extends unknown[]>(args: Args): PackArgs<Args> {
  if (args.length === 0) return undefined as PackArgs<Args>;
  if (args.length === 1) return args[0] as PackArgs<Args>;
  return args as PackArgs<Args>;
}

function unpackArgs<Args extends unknown[]>(packed: PackArgs<Args>, arity: number): Args {
  if (arity === 0) return [] as unknown as Args;
  if (arity === 1) return [packed] as Args;
  return packed as Args;
}

export type ServerActionHandle<Args extends unknown[], A> = {
  (...args: Args | [...Args, CallOptions]): Promise<A>;
  (): AsyncResult.AsyncResult<A, unknown>;
  set(...args: Args): Promise<A>;
  bind(...args: Args): (...ev: unknown[]) => void;
  with(...args: Args): (...ev: unknown[]) => void;
  readonly atom: Atom.Atom<unknown>;
  readonly $$atom: 1;
};

export type StreamActionHandle<Args extends unknown[], Y, R = void> = {
  (...args: Args | [...Args, CallOptions]): AsyncGenerator<Y, R, undefined>;
  set(...args: Args): AsyncGenerator<Y, R, undefined>;
  bind(...args: Args): (...ev: unknown[]) => void;
  with(...args: Args): (...ev: unknown[]) => void;
  readonly atom: undefined;
  readonly $$atom: 1;
};

function bindHandler<Args extends unknown[]>(
  key: string | undefined,
  invoke: (...args: Args) => void,
  args: Args,
): (...ev: unknown[]) => void {
  const handler = ((..._ev: unknown[]) => invoke(...args)) as ((...ev: unknown[]) => void) &
    Record<typeof ACTION_CALL, { k: string; a: unknown[] }>;
  if (key) handler[ACTION_CALL] = { k: key, a: args };
  return handler;
}

function defineServerAction<Args extends unknown[], A>(
  atom: Atom.Atom<unknown>,
  invoke: (...args: Args | [...Args, CallOptions]) => A | Promise<A>,
  opts?: { readOnEmpty?: boolean; captureKey?: string },
): ServerActionHandle<Args, A> {
  const readOnEmpty = opts?.readOnEmpty ?? false;
  const captureKey = opts?.captureKey;

  const run = ((...allArgs: Args | [...Args, CallOptions] | []) => {
    if (readOnEmpty && allArgs.length === 0) {
      return registry().get(atom) as AsyncResult.AsyncResult<A, unknown>;
    }
    if (readOnEmpty) {
      return Promise.resolve(invoke(...(allArgs as Args | [...Args, CallOptions])));
    }
    const { args } = splitCallOptions(allArgs as Args | [...Args, CallOptions]);
    return Promise.resolve(invoke(...(args as Args)));
  }) as ServerActionHandle<Args, A>;

  const set = (...args: Args) => {
    registry().set(
      atom as Atom.Writable<unknown, PackArgs<Args>>,
      packArgs(args) as PackArgs<Args>,
    );
    return Promise.resolve(invoke(...args));
  };

  const bind = (...args: Args) => {
    const key = captureKey ?? (run as { [ACTION_KEY]?: string })[ACTION_KEY];
    return bindHandler(key, (...a) => void set(...a), args);
  };

  Object.assign(run, {
    set,
    bind,
    with: bind,
    atom,
    $$atom: 1 as const,
  });

  if (captureKey) (run as { [ACTION_KEY]?: string })[ACTION_KEY] = captureKey;

  return run;
}

function defineStreamAction<Args extends unknown[], Y, R>(
  fn: (...args: Args) => AsyncGenerator<Y, R, unknown>,
): StreamActionHandle<Args, Y, R> {
  const call = ((...allArgs: Args | [...Args, CallOptions]) => {
    const { args } = splitCallOptions(allArgs as Args | [...Args, CallOptions]);
    return fn(...(args as Args));
  }) as StreamActionHandle<Args, Y, R>;

  const deny = () => {
    throw new Error("oxidejs: stream actions cannot be bound to DOM events");
  };

  Object.assign(call, {
    set: call,
    bind: deny,
    with: deny,
    atom: undefined,
    $$atom: 1 as const,
  });

  return call;
}

/** Attach an ilha server-island capture key to an action handle. */
export function brandServerAction<Args extends unknown[], A>(
  key: string,
  handle: ServerActionHandle<Args, A>,
): ServerActionHandle<Args, A> {
  (handle as { [ACTION_KEY]?: string })[ACTION_KEY] = key;
  return handle;
}

/** Wrap an RPC caller as an `Atom.fn`-shaped client action handle. */
export function wrapClientRpc<Args extends unknown[], A>(
  rpc: (...args: Args | [...Args, CallOptions]) => Promise<A>,
): ServerActionHandle<Args, A> {
  const arity = rpc.length;
  const invoke = (...args: Args | [...Args, CallOptions]) => Promise.resolve(rpc(...args));

  const atom = Atom.make(
    Atom.fn((packed: PackArgs<Args>) =>
      Effect.tryPromise({
        try: () => invoke(...unpackArgs<Args>(packed, arity)),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    ),
  );

  return defineServerAction(atom, (...args: Args | [...Args, CallOptions]) => invoke(...args), {
    readOnEmpty: true,
  });
}

/**
 * Marks a `*.server.ts` export as a remote RPC action. On the server the
 * underlying function runs locally; on the client the build replaces the module
 * with an `Atom.fn`-shaped RPC handle (`set`, `bind`, `AsyncResult` read).
 */
export function action<Args extends unknown[], Y, R = void>(
  fn: (...args: Args) => AsyncGenerator<Y, R, unknown>,
): StreamActionHandle<Args, Y, R>;
export function action<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): ServerActionHandle<Args, Awaited<Result>>;
export function action<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): ServerActionHandle<Args, Awaited<Result>> | StreamActionHandle<Args, unknown> {
  if (isAsyncGeneratorFunction(fn)) {
    return defineStreamAction(fn as (...args: Args) => AsyncGenerator<unknown, void, unknown>);
  }

  const arity = fn.length;
  const invoke = (...args: Args) =>
    Promise.resolve((fn as (...args: Args) => Result)(...args)) as Promise<Awaited<Result>>;

  const atom = Atom.make(
    Atom.fn((packed: PackArgs<Args>) =>
      Effect.tryPromise({
        try: () => invoke(...unpackArgs<Args>(packed, arity)),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    ),
  );

  return defineServerAction(
    atom,
    invoke as (
      ...args: Args | [...Args, CallOptions]
    ) => Awaited<Result> | Promise<Awaited<Result>>,
  );
}
