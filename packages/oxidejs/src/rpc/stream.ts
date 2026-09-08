import { Effect, Stream } from "effect";

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

/**
 * Re-enter `run` on every pull so request context survives yields (Effect may
 * drain after the outer ALS scope ends; WebContainer / Workers lose ALS across
 * awaits). Capture `useEnv()` / `requireDb()` before the first await in streams.
 */
export const bindAsyncGenContext = function bindAsyncGenContext<T>(
  gen: AsyncGenerator<T, unknown, unknown>,
  run: <R>(fn: () => R) => R
): AsyncGenerator<T, unknown, unknown> {
  return {
    next: (...args) => run(() => gen.next(...args)),
    return: (...args) => run(() => gen.return(...args)),
    throw: (...args) => run(() => gen.throw(...args)),
    [Symbol.asyncIterator]() {
      return this;
    },
    async [Symbol.asyncDispose]() {
      // AsyncGenerator.return requires a TReturn argument under TypeScript 6.
      // oxlint-disable-next-line unicorn/no-useless-undefined
      await run(() => gen.return(undefined));
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
