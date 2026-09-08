import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

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

export interface LiveQueryOptions {
  /** Sliding buffer size. Default 16. */
  capacity?: number;
  /** How many recent values late subscribers replay. Default 1. */
  replay?: number;
  /** Isolate-local topic key (`"tasks"`, `"room:42"`). */
  topic: string;
}

export interface LiveQuery<T> {
  /** Serialize work that produces a snapshot, then publish it. */
  mutate: (fn: () => Promise<T>) => Promise<T>;
  publish: (value: T) => void;
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

  const mutate = async function mutate(fn: () => Promise<T>) {
    const map = gates();
    const prev = map[topic] ?? Promise.resolve(null);
    const { promise, resolve } = Promise.withResolvers<null>();
    map[topic] = promise;
    await prev;
    try {
      const value = await fn();
      publishValue(value);
      return value;
    } finally {
      resolve(null);
    }
  };

  const values = function values(): AsyncIterable<T> {
    return Stream.toAsyncIterable(Stream.fromPubSub(hub));
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
    publish: publishValue,
    subscribe,
    topic,
    values,
  };
};

/** Publish to an existing `liveQuery` topic (no-op hub create with defaults). */
export const publish = function publish<T>(topic: string, value: T) {
  liveQuery<T>({ topic }).publish(value);
};
