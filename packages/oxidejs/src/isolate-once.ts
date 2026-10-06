import * as Effect from "effect/Effect";

import { deferred } from "./deferred";

/**
 * Default bound on one pass. A pass that has not settled by then fails and
 * clears, so the next caller retries.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Default time a caller waits on a pass another caller started before it
 * stops waiting and runs its own.
 */
const DEFAULT_WAIT_MS = 5000;

export interface IsolateOnceOptions {
  /**
   * Milliseconds before an unsettled pass fails and clears. Default 30 000.
   * Keep it under the host's request timeout: the pass holds every caller that
   * shares it.
   */
  timeout?: number;
  /**
   * Milliseconds a caller waits on a pass another caller started before it
   * stops waiting and runs its own. Default 5000.
   *
   * Required for celld / Workers safety: the host drops work a finished (or
   * aborted) request started, so a shared pass can be orphaned without ever
   * failing. Without this bound, every later caller waits on it forever.
   */
  wait?: number;
}

/** Rejection of a pass that outlived {@link IsolateOnceOptions.timeout}. */
export class IsolateOnceTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`isolateOnce: pass did not settle within ${timeoutMs}ms`);
    this.name = "IsolateOnceTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Cache key for a pass: the caller's binding object, or a private unkeyed slot. */
type PassKey = object;

interface Pass<A> {
  promise: Promise<A>;
  settled: boolean;
}

interface PassHandle<A> {
  pass: Pass<A>;
  /** True when this caller created the pass; only other callers wait on it. */
  created: boolean;
}

/** Runner arguments: none for the unkeyed form, one required key otherwise. */
type PassArgs<K> = [K] extends [never] ? [] : [key: K];

/** Drops the cached pass for a key (or the unkeyed slot), so the next call runs `fn` again. */
interface Resettable<K> {
  reset: (...args: PassArgs<K>) => void;
}

/** `isolateOnce` runner: call it to share the pass; `reset()` forgets it. */
export type IsolateOnceRunner<A, K extends PassKey = never> = ((
  ...args: PassArgs<K>
) => Promise<A>) &
  Resettable<K>;

/** `isolateOnceEffect` runner: call it for an Effect; `reset()` forgets the pass. */
export type IsolateOnceEffectRunner<A, K extends PassKey = never> = ((
  ...args: PassArgs<K>
) => Effect.Effect<A>) &
  Resettable<K>;

/** Reject `work` once `timeoutMs` passes without it settling. */
const withTimeout = async <A>(
  work: Promise<A>,
  timeoutMs: number
): Promise<A> => {
  const expired = deferred<never>();
  const timer = setTimeout(() => {
    expired.reject(new IsolateOnceTimeoutError(timeoutMs));
  }, timeoutMs);
  try {
    return await Promise.race([work, expired.promise]);
  } finally {
    clearTimeout(timer);
  }
};

/** Resolve `true` when `waitMs` passes before `pass` settles. */
const waitFor = async <A>(pass: Pass<A>, waitMs: number): Promise<boolean> => {
  const expired = deferred<true>();
  const timer = setTimeout(() => {
    expired.resolve(true);
  }, waitMs);
  // Resolve `false` once the pass settles, either way; only the timer resolves
  // `true`. The caller re-observes the pass rejection, so ignoring it here just
  // lets the race finish.
  const settled = (async () => {
    try {
      await pass.promise;
    } catch {
      // Handled by the caller.
    }
    return false;
  })();
  try {
    return await Promise.race([settled, expired.promise]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Run `fn` at most once per isolate, concurrently-safe and time-bounded.
 *
 * Concurrent callers share one in-flight pass. The pass has a `timeout`; a
 * failure or timeout clears it so the next caller retries. A caller that waits
 * `wait` ms on a pass another caller started stops waiting and runs its own
 * pass — the pass may have been orphaned when the request that started it
 * ended (celld and Workers drop a finished request's pending work). Success is
 * cached for the isolate.
 *
 * Key the pass when `fn` needs a per-binding run — pass the binding object as
 * the key (stored in a `WeakMap`, so it does not leak). Omit the key for one
 * pass per isolate. `reset(key?)` forgets the cached pass so the next call
 * runs `fn` again; callers already awaiting an in-flight pass still get its
 * result.
 *
 * ```ts
 * import { isolateOnce } from "oxidejs";
 *
 * const ensureDb = isolateOnce(
 *   (db: D1Database) =>
 *     Effect.runPromise(migrate.pipe(Effect.provide(dbLayer(db)), Effect.scoped)),
 *   { timeout: 15_000, wait: 5000 }
 * );
 *
 * export const ensureDbForRequest = (db: D1Database) => ensureDb(db);
 * ```
 */
export const isolateOnce = <A, K extends PassKey = never>(
  fn: (key: K) => A | Promise<A>,
  options: IsolateOnceOptions = {}
): IsolateOnceRunner<A, K> => {
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const waitMs = options.wait ?? DEFAULT_WAIT_MS;
  // Every isolateOnce gets its own unkeyed slot, so two unkeyed runs never
  // share a pass.
  const unkeyed = {};
  const passes = new WeakMap<PassKey, Pass<A>>();
  const cacheKeyOf = (args: PassArgs<K>) => {
    // SAFETY: `PassArgs` is `[]` or `[key: K]`; a non-empty tuple's first
    // element is the key.
    const key = args.length === 0 ? undefined : (args as [K])[0];
    return { cacheKey: key ?? unkeyed, key };
  };

  const passFor = <Key extends PassKey>(
    cacheKey: Key,
    invoke: () => A | Promise<A>
  ): PassHandle<A> => {
    const cached = passes.get(cacheKey);
    if (cached) {
      return { created: false, pass: cached };
    }
    let work: Promise<A>;
    try {
      work = Promise.resolve(invoke());
    } catch (error) {
      work = Promise.reject(error);
    }
    const pass: Pass<A> = {
      promise: withTimeout(work, timeoutMs),
      settled: false,
    };
    passes.set(cacheKey, pass);
    const track = async () => {
      try {
        await pass.promise;
        pass.settled = true;
      } catch {
        // A failed or timed-out pass must not poison the isolate: drop it so
        // the next caller retries. Only clear the slot while this pass still
        // owns it — a waiter or `reset()` may have replaced it already.
        pass.settled = true;
        if (passes.get(cacheKey) === pass) {
          passes.delete(cacheKey);
        }
      }
    };
    void track();
    return { created: true, pass };
  };

  const run = async (...args: PassArgs<K>): Promise<A> => {
    const { cacheKey, key } = cacheKeyOf(args);
    // SAFETY: `undefined` only reaches `fn` for the unkeyed form, whose
    // callback ignores the argument.
    const invoke = () => fn(key as K);
    const handle = passFor(cacheKey, invoke);
    if (handle.created) {
      return handle.pass.promise;
    }
    const stale = await waitFor(handle.pass, waitMs);
    if (!stale) {
      return handle.pass.promise;
    }
    // This caller waited `wait` ms on a pass another request owns. That
    // request may be gone, so stop waiting and run a pass this caller owns.
    if (!handle.pass.settled && passes.get(cacheKey) === handle.pass) {
      passes.delete(cacheKey);
    }
    // Re-read: a successful pass may have landed, or another waiter may have
    // already replaced it; otherwise this starts a fresh pass.
    return passFor(cacheKey, invoke).pass.promise;
  };

  const reset = (...args: PassArgs<K>) => {
    passes.delete(cacheKeyOf(args).cacheKey);
  };

  return Object.assign(run, { reset });
};

/**
 * Effect wrapper around {@link isolateOnce}. A pass failure or timeout is a
 * host abort (a defect), not a typed domain error — use
 * `Effect.tryPromise(() => run(key))` when you want it in the error channel.
 */
export const isolateOnceEffect = <A, K extends PassKey = never>(
  fn: (key: K) => A | Promise<A>,
  options?: IsolateOnceOptions
): IsolateOnceEffectRunner<A, K> => {
  const run = isolateOnce(fn, options);
  return Object.assign(
    (...args: PassArgs<K>) => Effect.promise(() => run(...args)),
    { reset: run.reset }
  );
};
