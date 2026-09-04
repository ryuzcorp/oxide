import { Effect, Stream } from "effect";
import { inWebcontainer } from "../context";

export function asyncGenToStream<T>(gen: AsyncGenerator<T, unknown, unknown>) {
  return Stream.fromAsyncIterable(gen, (error) =>
    error instanceof Error ? error : new Error(String(error)),
  );
}

/** Serialize WebContainer stream pulls so the shared syncStore is not stomped. */
let pullTail: Promise<void> = Promise.resolve();

/**
 * Re-enter `run` for every generator pull so request context stays available
 * across yields (Effect may drain the stream after the outer ALS scope ends;
 * WebContainer also loses ALS across awaits, so `run` must reinstall the store).
 * On WebContainer, pulls are serialized through settlement so concurrent streams
 * cannot replace the sync fallback mid-pull. `withRequestEntry` is unchanged.
 */
export function bindAsyncGenContext<T>(
  gen: AsyncGenerator<T, unknown, unknown>,
  run: <R>(fn: () => R) => R,
): AsyncGenerator<T, unknown, unknown> {
  const runPull = <R>(fn: () => R): R => {
    if (!inWebcontainer()) return run(fn);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = pullTail;
    pullTail = gate;

    return prev
      .then(() => Promise.resolve(run(fn)))
      .finally(() => {
        release();
      }) as R;
  };

  const wrapped = {
    next: (value?: unknown) => runPull(() => gen.next(value)),
    return: (value?: unknown) => runPull(() => gen.return(value)),
    throw: (error?: unknown) => runPull(() => gen.throw(error)),
    [Symbol.asyncIterator]() {
      return this;
    },
    async [Symbol.asyncDispose]() {
      await runPull(() => gen.return(undefined));
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
