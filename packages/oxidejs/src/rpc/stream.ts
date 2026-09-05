import { Effect, Stream } from "effect";

import { inWebcontainer } from "../context";

const onAsyncIterableError = function onAsyncIterableError(
  cause: unknown
): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
};

export const asyncGenToStream = function asyncGenToStream<T>(
  gen: AsyncGenerator<T, unknown, unknown>
) {
  return Stream.fromAsyncIterable(gen, onAsyncIterableError);
};

/** Serialize WebContainer stream pulls so the shared syncStore is not stomped. */
let pullTail: Promise<null> = Promise.resolve(null);

/**
 * Re-enter `run` for every generator pull so request context stays available
 * across yields (Effect may drain the stream after the outer ALS scope ends;
 * WebContainer also loses ALS across awaits, so `run` must reinstall the store).
 * On WebContainer, pulls are serialized through settlement so concurrent streams
 * cannot replace the sync fallback mid-pull. `withRequestEntry` is unchanged.
 */
export const bindAsyncGenContext = function bindAsyncGenContext<T>(
  gen: AsyncGenerator<T, unknown, unknown>,
  run: <R>(fn: () => R) => R
): AsyncGenerator<T, unknown, unknown> {
  const runPull = function runPull<R>(fn: () => R): R {
    if (!inWebcontainer()) {
      return run(fn);
    }

    const { promise: gate, resolve: release } = Promise.withResolvers<null>();
    const prev = pullTail;
    pullTail = gate;

    const runSerialized = async function runSerialized() {
      await prev;
      try {
        return await run(fn);
      } finally {
        release(null);
      }
    };

    // SAFETY: Callers only use runPull for gen.next/return/throw, which always return Promise; the serialized Promise is assignable to that R.
    return runSerialized() as R;
  };

  return {
    next: (...args) => runPull(() => gen.next(...args)),
    return: (...args) => runPull(() => gen.return(...args)),
    throw: (...args) => runPull(() => gen.throw(...args)),
    [Symbol.asyncIterator]() {
      return this;
    },
    async [Symbol.asyncDispose]() {
      // AsyncGenerator.return requires a TReturn argument under TypeScript 6.
      // oxlint-disable-next-line unicorn/no-useless-undefined
      await runPull(() => gen.return(undefined));
    },
  };
};

/** Create a generator inside `run`, then keep every subsequent pull inside `run`. */
export const asyncGenToStreamInContext = function asyncGenToStreamInContext<T>(
  create: () => AsyncGenerator<T, unknown, unknown>,
  run: <R>(fn: () => R) => R
) {
  return asyncGenToStream(bindAsyncGenContext(run(create), run));
};

export const streamToAsyncGen = function streamToAsyncGen<T>(
  stream: Stream.Stream<T>
) {
  return Stream.toAsyncIterable(stream);
};

export const runStream = async function runStream<A>(stream: Stream.Stream<A>) {
  const chunk = await Effect.runPromise(Stream.runCollect(stream));
  return chunk.values();
};
