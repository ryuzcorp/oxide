import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { deferred } from "./deferred";

const HUBS_KEY = Symbol.for("oxidejs.liveQuery.hubs");
const GATES_KEY = Symbol.for("oxidejs.liveQuery.gates");

interface HubBag {
  [topic: string]: PubSub.PubSub<unknown>;
}

interface GateBag {
  [topic: string]: Promise<null>;
}

const hubs = function hubs(): HubBag {
  // SAFETY: isolate-global topic → PubSub map; Symbol.for is oxide-owned.
  const g = globalThis as typeof globalThis & { [HUBS_KEY]?: HubBag };
  return (g[HUBS_KEY] ??= {});
};

const gates = function gates(): GateBag {
  // SAFETY: isolate-global topic → serialize gate; Symbol.for is oxide-owned.
  const g = globalThis as typeof globalThis & { [GATES_KEY]?: GateBag };
  return (g[GATES_KEY] ??= {});
};

const hubFor = function hubFor<T>(
  topic: string,
  capacity: number,
  replay: number
): PubSub.PubSub<T> {
  const map = hubs();
  const existing = map[topic];
  if (existing) {
    // SAFETY: each topic is created once for a fixed T; callers must not reuse a topic with another T.
    return existing as PubSub.PubSub<T>;
  }
  const created = Effect.runSync(PubSub.sliding<T>({ capacity, replay }));
  // SAFETY: store erased hub; topic identity keeps T consistent for this process.
  map[topic] = created as PubSub.PubSub<unknown>;
  return created;
};

/** FIFO gate so concurrent mutators on one topic do not interleave. */
const withTopicGate = function withTopicGate<A, E, R>(
  topic: string,
  body: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      const map = gates();
      const prev = map[topic] ?? Promise.resolve(null);
      const { promise, resolve } = deferred<null>();
      map[topic] = promise;
      await prev;
      return resolve;
    }),
    () => body,
    (resolve) => Effect.sync(() => resolve(null))
  );
};

export interface LiveQueryOptions {
  /** Sliding buffer size. Default 16. */
  capacity?: number;
  /** How many recent values late subscribers replay. Default 1. */
  replay?: number;
  /** Isolate-local topic key (`"tasks"`, `"room:42"`). */
  topic: string;
}

export interface LiveQuery<T> {
  /**
   * Serialize Effect work that produces a snapshot, then publish it.
   * Prefer this from Effect action handlers.
   */
  mutateEffect: <E, R>(
    fn: () => Effect.Effect<T, E, R>
  ) => Effect.Effect<T, E, R>;
  /** Serialize Promise work that produces a snapshot, then publish it. */
  mutate: (fn: () => Promise<T>) => Promise<T>;
  publish: (value: T) => void;
  /** Effect `Stream` of published values (replays when configured). */
  stream: () => Stream.Stream<T>;
  /**
   * `stream()` after an optional Effect seed (capture bindings before subscribe).
   * Use with `action(() => Stream.unwrap(...), { stream: true })`.
   */
  subscribeStream: <E = never, R = never>(
    seed?: Effect.Effect<void, E, R>
  ) => Stream.Stream<T, E, R>;
  /**
   * Returns an async generator factory for `action()`.
   * Optional `seed` runs once before subscribing (capture `useEnv()` first).
   */
  subscribe: (
    seed?: () => Promise<void>
  ) => () => AsyncGenerator<T, void, unknown>;
  readonly topic: string;
  /** Async iterable of published values (replays when configured). */
  values: () => AsyncIterable<T>;
}

/** Isolate-local sliding hub: query = subscription, mutation = publish. */
export const liveQuery = function liveQuery<T>(
  options: LiveQueryOptions
): LiveQuery<T> {
  const capacity = options.capacity ?? 16;
  const replay = options.replay ?? 1;
  const { topic } = options;
  const hub = hubFor<T>(topic, capacity, replay);

  const publishValue = function publishValue(value: T) {
    Effect.runSync(PubSub.publish(hub, value));
  };

  const mutateEffect = function mutateEffect<E, R>(
    fn: () => Effect.Effect<T, E, R>
  ): Effect.Effect<T, E, R> {
    return withTopicGate(
      topic,
      Effect.gen(function* mutateEffectGen() {
        const value = yield* fn();
        publishValue(value);
        return value;
      })
    );
  };

  const mutate = async function mutate(fn: () => Promise<T>) {
    return await Effect.runPromise(
      mutateEffect(() =>
        Effect.tryPromise({
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(String(cause)),
          try: fn,
        })
      )
    );
  };

  const stream = function stream(): Stream.Stream<T> {
    return Stream.fromPubSub(hub);
  };

  const subscribeStream = function subscribeStream<E = never, R = never>(
    seed?: Effect.Effect<void, E, R>
  ): Stream.Stream<T, E, R> {
    if (!seed) {
      // SAFETY: PubSub streams have never Fail / never Services.
      return stream() as Stream.Stream<T, E, R>;
    }
    return Stream.unwrap(seed.pipe(Effect.map(() => stream())));
  };

  const values = function values(): AsyncIterable<T> {
    return Stream.toAsyncIterable(stream());
  };

  const subscribe = function subscribe(seed?: () => Promise<void>) {
    return async function* liveSubscribe(): AsyncGenerator<T, void, unknown> {
      if (seed) {
        await seed();
      }
      yield* values();
    };
  };

  return {
    mutate,
    mutateEffect,
    publish: publishValue,
    stream,
    subscribe,
    subscribeStream,
    topic,
    values,
  };
};

/** Publish to an existing `liveQuery` topic (no-op hub create with defaults). */
export const publish = function publish<T>(topic: string, value: T) {
  liveQuery<T>({ topic }).publish(value);
};
