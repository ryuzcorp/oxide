import * as Effect from "effect/Effect";
import type * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as Registry from "effect/unstable/reactivity/AtomRegistry";

export const ACTION_CALL = Symbol.for("ilha.actionCall");
const ACTION_KEY = Symbol.for("oxidejs.actionKey");

const asyncGeneratorProbe = async function* asyncGeneratorProbe() {
  yield;
};
// SAFETY: getPrototypeOf(async generator).constructor is the AsyncGeneratorFunction constructor.
const AsyncGeneratorFunction = Object.getPrototypeOf(asyncGeneratorProbe)
  .constructor as new (
  ...args: string[]
) => (...args: never[]) => AsyncGenerator;

interface CallOptions {
  signal?: AbortSignal;
}

interface SplitCallResult<Args extends unknown[]> {
  args: Args;
  options?: CallOptions;
}

interface ActionKeyCarrier {
  [ACTION_KEY]?: string;
}

interface ActionCallPayload {
  a: unknown[];
  k: string;
}

interface ActionCallHandler {
  (...ev: unknown[]): void;
  [ACTION_CALL]?: ActionCallPayload;
}

interface DefineServerActionOpts {
  captureKey?: string;
  stripCallOptions?: boolean;
}

/** Atom write payload is always the argument list (never collapsed), so rest stubs / single-array args stay intact. */
type PackArgs<Args extends unknown[]> = Args;

type ActionExport = (
  ...args: never[]
) =>
  | AsyncGenerator
  | PromiseLike<object | string | number | boolean | null | undefined>
  | object
  | string
  | number
  | boolean
  | null
  | undefined;

let defaultRegistry: Registry.AtomRegistry | undefined;

const registry = function registry(): Registry.AtomRegistry {
  return (defaultRegistry ??= Registry.make());
};

const isAsyncGeneratorFunction = function isAsyncGeneratorFunction<
  T extends ActionExport,
>(fn: T): fn is T & ((...args: never[]) => AsyncGenerator) {
  return fn instanceof AsyncGeneratorFunction;
};

const emptyArgs = function emptyArgs<Args extends unknown[]>(): Args {
  // SAFETY: an empty argument list is valid for any Args extends unknown[].
  return [] as never;
};

const asArgs = function asArgs<Args extends unknown[]>(
  value: readonly unknown[]
): Args {
  // SAFETY: caller peeled CallOptions; remaining tuple matches Args.
  return value as Args;
};

const readActionKey = function readActionKey(
  target: ActionKeyCarrier
): string | undefined {
  return target[ACTION_KEY];
};

const writeActionKey = function writeActionKey(
  target: ActionKeyCarrier,
  key: string
) {
  target[ACTION_KEY] = key;
};

const denyStreamBind = function denyStreamBind(): never {
  throw new Error("oxidejs: stream actions cannot be bound to DOM events");
};

const splitCallOptions = function splitCallOptions<Args extends unknown[]>(
  args: Args | [...Args, CallOptions]
): SplitCallResult<Args> {
  if (args.length === 0) {
    return { args: emptyArgs<Args>() };
  }
  const last = args.at(-1);
  if (
    last instanceof Object &&
    !Array.isArray(last) &&
    "signal" in last &&
    last.signal instanceof AbortSignal &&
    Object.keys(last).length === 1
  ) {
    return {
      args: asArgs<Args>(args.slice(0, -1)),
      options: { signal: last.signal },
    };
  }
  // SAFETY: no trailing CallOptions; the full list is Args.
  return { args: args as Args };
};

export interface ServerActionHandle<Args extends unknown[], A> {
  (...args: Args | [...Args, CallOptions]): Promise<A>;
  set: (...args: Args) => Promise<A>;
  bind: (...args: Args) => (...ev: unknown[]) => void;
  with: (...args: Args) => (...ev: unknown[]) => void;
  /** Last `AsyncResult` for this action's client atom (does not invoke RPC). */
  readonly result: AsyncResult.AsyncResult<A, unknown>;
  readonly atom: Atom.Atom<unknown>;
  readonly $$atom: 1;
}

export interface StreamActionHandle<Args extends unknown[], Y, R = void> {
  (...args: Args | [...Args, CallOptions]): AsyncGenerator<Y, R, undefined>;
  set: (...args: Args) => AsyncGenerator<Y, R, undefined>;
  bind: (...args: Args) => (...ev: unknown[]) => void;
  with: (...args: Args) => (...ev: unknown[]) => void;
  readonly atom: undefined;
  readonly $$atom: 1;
}

const bindHandler = function bindHandler<Args extends unknown[]>(
  key: string | undefined,
  invoke: (...args: Args) => void,
  args: Args
): (...ev: unknown[]) => void {
  // SAFETY: ACTION_CALL is attached below when a capture key is present.
  const handler = ((..._ev: unknown[]) => {
    invoke(...args);
  }) as ActionCallHandler;
  if (key) {
    handler[ACTION_CALL] = { a: args, k: key };
  }
  return handler;
};

const defineServerAction = function defineServerAction<
  Args extends unknown[],
  A,
>(
  atom: Atom.Atom<unknown>,
  invoke: (...args: Args | [...Args, CallOptions]) => A | Promise<A>,
  opts?: DefineServerActionOpts
): ServerActionHandle<Args, A> {
  const captureKey = opts?.captureKey;
  const stripCallOptions = opts?.stripCallOptions ?? true;

  // SAFETY: Object.assign below installs set/bind/with/atom/$$atom on this callable.
  const run = ((...allArgs: Args | [...Args, CallOptions]) => {
    if (!stripCallOptions) {
      return Promise.resolve(invoke(...allArgs));
    }
    const { args } = splitCallOptions<Args>(allArgs);
    return Promise.resolve(invoke(...args));
  }) as ServerActionHandle<Args, A>;

  const set = (...args: Args) => {
    // SAFETY: Atom.fn write side accepts the packed Args tuple for this action.
    registry().set(
      atom as Atom.Writable<unknown, PackArgs<Args>>,
      args as PackArgs<Args>
    );
    return Promise.resolve(invoke(...args));
  };

  const bind = (...args: Args) => {
    // SAFETY: run may carry ACTION_KEY from brandServerAction / captureKey.
    const key = captureKey ?? readActionKey(run as ActionKeyCarrier);
    return bindHandler(
      key,
      (...a) => {
        set(...a);
      },
      args
    );
  };

  Object.assign(run, {
    $$atom: 1 as const,
    atom,
    bind,
    set,
    with: bind,
  });
  Object.defineProperty(run, "result", {
    enumerable: true,
    // SAFETY: registry stores AsyncResult for this action atom.
    get: () => registry().get(atom) as AsyncResult.AsyncResult<A, unknown>,
  });

  if (captureKey) {
    // SAFETY: run is the callable handle we brand with ACTION_KEY.
    writeActionKey(run as ActionKeyCarrier, captureKey);
  }

  return run;
};

const defineStreamAction = function defineStreamAction<
  Args extends unknown[],
  Y,
  R,
>(
  fn: (...args: Args) => AsyncGenerator<Y, R, unknown>
): StreamActionHandle<Args, Y, R> {
  // SAFETY: Object.assign below installs set/bind/with/atom/$$atom on this callable.
  const call = ((...allArgs: Args | [...Args, CallOptions]) => {
    const { args } = splitCallOptions<Args>(allArgs);
    return fn(...args);
  }) as StreamActionHandle<Args, Y, R>;

  Object.assign(call, {
    $$atom: 1 as const,
    atom: undefined,
    bind: denyStreamBind,
    set: call,
    with: denyStreamBind,
  });

  return call;
};

/** Attach an ilha server-island capture key to an action handle. */
export const brandServerAction = function brandServerAction<
  Args extends unknown[],
  A,
>(
  key: string,
  handle: ServerActionHandle<Args, A>
): ServerActionHandle<Args, A> {
  // SAFETY: handle is the callable we brand with ACTION_KEY for ilha capture.
  writeActionKey(handle as ActionKeyCarrier, key);
  return handle;
};

/** Wrap an RPC caller as an `Atom.fn`-shaped client action handle. */
export const wrapClientRpc = function wrapClientRpc<Args extends unknown[], A>(
  rpc: (...args: Args | [...Args, CallOptions]) => Promise<A>
): ServerActionHandle<Args, A> {
  const invoke = (...args: Args | [...Args, CallOptions]) =>
    Promise.resolve(rpc(...args));

  const atom = Atom.make(
    Atom.fn((packed: PackArgs<Args>) =>
      Effect.tryPromise({
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
        // SAFETY: Atom.fn packs the full Args tuple as the write payload.
        try: () => invoke(...(packed as Args)),
      })
    )
  );

  return defineServerAction(
    atom,
    (...args: Args | [...Args, CallOptions]) => invoke(...args),
    {
      // Client stubs forward optional `{ signal }` into Effect RPC — do not peel it here.
      stripCallOptions: false,
    }
  );
};

/**
 * Wrap a streaming RPC caller so the client handle returns an async generator
 * (awaiting the underlying client lazily), not `Promise<AsyncGenerator>`.
 */
export const wrapClientStreamRpc = function wrapClientStreamRpc<
  Args extends unknown[],
  Y,
  R = void,
>(
  rpc: (
    ...args: Args | [...Args, CallOptions]
  ) => AsyncGenerator<Y, R, undefined>
): StreamActionHandle<Args, Y, R> {
  return defineStreamAction((...args: Args) => rpc(...args));
};

/**
 * Marks a `*.server.ts` export as a remote RPC action. On the server the
 * underlying function runs locally; on the client the build replaces the module
 * with an `Atom.fn`-shaped RPC handle (`set`, `bind`, `result`).
 */
export function action<Args extends unknown[], Y, R = void>(
  fn: (...args: Args) => AsyncGenerator<Y, R, unknown>
): StreamActionHandle<Args, Y, R>;
export function action<Args extends unknown[], Result>(
  fn: (...args: Args) => Result
): ServerActionHandle<Args, Awaited<Result>>;
export function action<Args extends unknown[], Result>(
  fn: (...args: Args) => Result
):
  | ServerActionHandle<Args, Awaited<Result>>
  | StreamActionHandle<Args, unknown> {
  // SAFETY: ActionExport uses never[] params; Args is the real call signature.
  if (isAsyncGeneratorFunction(fn as never)) {
    // SAFETY: instanceof AsyncGeneratorFunction narrows to an async generator export.
    return defineStreamAction(
      fn as (...args: Args) => AsyncGenerator<unknown, void, unknown>
    );
  }

  // SAFETY: non-generator branch; fn returns Result / Promise<Result>.
  const invoke = (...args: Args) =>
    Promise.resolve(fn(...args)) as Promise<Awaited<Result>>;

  const atom = Atom.make(
    Atom.fn((packed: PackArgs<Args>) =>
      Effect.tryPromise({
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
        // SAFETY: Atom.fn packs the full Args tuple as the write payload.
        try: () => invoke(...(packed as Args)),
      })
    )
  );

  return defineServerAction(
    atom,
    // SAFETY: invoke already awaits Result; CallOptions are peeled inside defineServerAction.
    invoke as (
      ...args: Args | [...Args, CallOptions]
    ) => Awaited<Result> | Promise<Awaited<Result>>
  );
}
