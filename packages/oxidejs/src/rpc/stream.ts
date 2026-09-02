import { Effect, Stream } from "effect";

export function asyncGenToStream<T>(gen: AsyncGenerator<T, unknown, unknown>) {
  return Stream.fromAsyncIterable(gen, (error) =>
    error instanceof Error ? error : new Error(String(error)),
  );
}

export function streamToAsyncGen<T>(stream: Stream.Stream<T>) {
  return Stream.toAsyncIterable(stream);
}

export function runStream<A>(stream: Stream.Stream<A>) {
  return Effect.runPromise(Stream.runCollect(stream)).then((chunk) => chunk.values());
}
