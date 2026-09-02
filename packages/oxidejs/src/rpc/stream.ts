import { Effect, Stream } from "effect";

export function asyncGenToStream<T>(gen: AsyncGenerator<T, unknown, unknown>) {
  return Stream.fromAsyncIterable(gen, (error) =>
    error instanceof Error ? error : new Error(String(error)),
  );
}

/**
 * Re-enter `run` for every generator pull so AsyncLocalStorage request context
 * stays available across yields (Effect may drain the stream after the outer ALS scope ends).
 */
export function bindAsyncGenContext<T>(
  gen: AsyncGenerator<T, unknown, unknown>,
  run: <R>(fn: () => R) => R,
): AsyncGenerator<T, unknown, unknown> {
  const wrapped = {
    next: (value?: unknown) => run(() => gen.next(value)),
    return: (value?: unknown) => run(() => gen.return(value)),
    throw: (error?: unknown) => run(() => gen.throw(error)),
    [Symbol.asyncIterator]() {
      return this;
    },
    async [Symbol.asyncDispose]() {
      await run(() => gen.return(undefined));
    },
  };
  return wrapped as AsyncGenerator<T, unknown, unknown>;
}

/** Create a generator inside `run`, then keep every subsequent pull inside `run`. */
export function asyncGenToStreamInContext<T>(
  create: () => AsyncGenerator<T, unknown, unknown>,
  run: <R>(fn: () => R) => R,
) {
  return asyncGenToStream(bindAsyncGenContext(run(create), run));
}

export function streamToAsyncGen<T>(stream: Stream.Stream<T>) {
  return Stream.toAsyncIterable(stream);
}

export function runStream<A>(stream: Stream.Stream<A>) {
  return Effect.runPromise(Stream.runCollect(stream)).then((chunk) => chunk.values());
}
