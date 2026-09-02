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

/** Atom write payload is always the argument list (never collapsed), so rest stubs / single-array args stay intact. */
type PackArgs<Args extends unknown[]> = Args;

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

export type ServerActionHandle<Args extends unknown[], A> = {
  (...args: Args | [...Args, CallOptions]): Promise<A>;
  set(...args: Args): Promise<A>;
  bind(...args: Args): (...ev: unknown[]) => void;
  with(...args: Args): (...ev: unknown[]) => void;
  /** Last `AsyncResult` for this action's client atom (does not invoke RPC). */
  readonly result: AsyncResult.AsyncResult<A, unknown>;
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
  opts?: { captureKey?: string; stripCallOptions?: boolean },
): ServerActionHandle<Args, A> {
  const captureKey = opts?.captureKey;
  const stripCallOptions = opts?.stripCallOptions ?? true;

  const run = ((...allArgs: Args | [...Args, CallOptions]) => {
    if (!stripCallOptions) {
      return Promise.resolve(invoke(...(allArgs as Args | [...Args, CallOptions])));
    }
    const { args } = splitCallOptions(allArgs as Args | [...Args, CallOptions]);
    return Promise.resolve(invoke(...(args as Args)));
  }) as ServerActionHandle<Args, A>;

  const set = (...args: Args) => {
    registry().set(atom as Atom.Writable<unknown, PackArgs<Args>>, args as PackArgs<Args>);
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
  Object.defineProperty(run, "result", {
    enumerable: true,
    get: () => registry().get(atom) as AsyncResult.AsyncResult<A, unknown>,
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
  const invoke = (...args: Args | [...Args, CallOptions]) => Promise.resolve(rpc(...args));

  const atom = Atom.make(
    Atom.fn((packed: PackArgs<Args>) =>
      Effect.tryPromise({
        try: () => invoke(...(packed as Args)),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    ),
  );

  return defineServerAction(atom, (...args: Args | [...Args, CallOptions]) => invoke(...args), {
    // Client stubs forward optional `{ signal }` into Effect RPC — do not peel it here.
    stripCallOptions: false,
  });
}

/**
 * Wrap a streaming RPC caller so the client handle returns an async generator
 * (awaiting the underlying client lazily), not `Promise<AsyncGenerator>`.
 */
export function wrapClientStreamRpc<Args extends unknown[], Y, R = void>(
  rpc: (...args: Args | [...Args, CallOptions]) => AsyncGenerator<Y, R, undefined>,
): StreamActionHandle<Args, Y, R> {
  return defineStreamAction((...args: Args) => rpc(...args));
}

/**
 * Marks a `*.server.ts` export as a remote RPC action. On the server the
 * underlying function runs locally; on the client the build replaces the module
 * with an `Atom.fn`-shaped RPC handle (`set`, `bind`, `result`).
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

  const invoke = (...args: Args) =>
    Promise.resolve((fn as (...args: Args) => Result)(...args)) as Promise<Awaited<Result>>;

  const atom = Atom.make(
    Atom.fn((packed: PackArgs<Args>) =>
      Effect.tryPromise({
        try: () => invoke(...(packed as Args)),
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
