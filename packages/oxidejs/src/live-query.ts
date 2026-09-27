import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { deferred } from "./deferred";

const DEFAULT_MUTATE_WAIT_MS = 10_000;
const HUBS_KEY = Symbol.for("oxidejs.liveQuery.hubs");
const GATES_KEY = Symbol.for("oxidejs.liveQuery.gates");
const ORDER_KEY = Symbol.for("oxidejs.liveQuery.order");

/** A mutation finished after `close()` shut its topic down: nobody got its snapshot. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory
export class LiveQueryClosedError extends Schema.TaggedError<LiveQueryClosedError>()(
  "LiveQueryClosedError",
  { message: Schema.String, topic: Schema.String }
) {}

/** Per topic: the last ticket handed to a mutation and the newest one published. */
interface TopicOrder {
  issued: number;
  published: number;
}

interface OrderBag {
  [topic: string]: TopicOrder;
}

const orderFor = function orderFor(topic: string): TopicOrder {
  // SAFETY: isolate-global topic → mutation order; Symbol.for is oxide-owned.
  const g = globalThis as typeof globalThis & { [ORDER_KEY]?: OrderBag };
  g[ORDER_KEY] ??= {};
  const bag = g[ORDER_KEY];
  bag[topic] ??= { issued: 0, published: 0 };
  return bag[topic];
};

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
/**
 * Serialize mutations per topic, but never wait on the previous one longer
 * than `waitMs`. The previous holder can belong to another request, and a
 * Worker host (celld) drops a finished or aborted request's pending work, so
 * its release may never run; an unbounded wait would then block the topic
 * until the isolate restarts.
 */
const withTopicGate = function withTopicGate<A, E, R>(
  topic: string,
  waitMs: number,
  body: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      const map = gates();
      const prev = map[topic] ?? Promise.resolve(null);
      const { promise, resolve: releaseGate } = deferred<null>();
      map[topic] = promise;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // oxlint-disable-next-line promise/avoid-new -- a timer-backed race needs its own Promise
      const expired = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs);
      });
      try {
        await Promise.race([prev, expired]);
      } finally {
        clearTimeout(timer);
      }
      return () => {
        releaseGate(null);
        if (map[topic] === promise) {
          Reflect.deleteProperty(map, topic);
        }
      };
    }),
    () => body,
    (release) => Effect.sync(release)
  );
};

export interface LiveQueryOptions {
  /** Sliding buffer size. Default 16. */
  capacity?: number;
  /**
   * Longest time a mutation waits for the previous mutation of its topic
   * before it runs anyway. Default: 10000.
   */
  mutateWaitMs?: number;
  /** How many recent values late subscribers replay. Default 1. */
  replay?: number;
  /** Isolate-local topic key (`"tasks"`, `"room:42"`). */
  topic: string;
}

/**
 * A live query is local to one isolate: `publish` reaches subscribers of the
 * same process only, not other Worker isolates or other celld nodes. Use a
 * Durable Object (one cell per topic) to fan out across a fleet.
 */
export interface LiveQuery<T> {
  /** Shut the topic's hub down and forget it; open streams end. */
  close: () => void;
  /**
   * Serialize Effect work that produces a snapshot, then publish it.
   * Prefer this from Effect action handlers.
   */
  mutateEffect: <E, R>(
    fn: () => Effect.Effect<T, E, R>
  ) => Effect.Effect<T, E | LiveQueryClosedError, R>;
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
  const mutateWaitMs = options.mutateWaitMs ?? DEFAULT_MUTATE_WAIT_MS;
  const { topic } = options;
  const hub = hubFor<T>(topic, capacity, replay);

  const publishValue = function publishValue(value: T) {
    Effect.runSync(PubSub.publish(hub, value));
  };

  /**
   * Each mutation takes a ticket in gate order. The bounded gate can let a
   * later mutation run while an earlier one is still working, so a mutation
   * publishes only if no newer ticket has published yet: an older snapshot
   * never overwrites a newer one. A mutation whose topic was closed fails
   * with {@link LiveQueryClosedError} instead of reporting success.
   */
  const mutateEffect = function mutateEffect<E, R>(
    fn: () => Effect.Effect<T, E, R>
  ): Effect.Effect<T, E | LiveQueryClosedError, R> {
    return Effect.suspend(() => {
      const order = orderFor(topic);
      order.issued += 1;
      const ticket = order.issued;
      return withTopicGate(
        topic,
        mutateWaitMs,
        Effect.gen(function* mutateEffectGen() {
          const value = yield* fn();
          if (ticket < order.published) {
            // Superseded: a newer mutation already published its snapshot.
            return value;
          }
          const published = Effect.runSync(PubSub.publish(hub, value));
          if (!published) {
            return yield* Effect.fail(
              new LiveQueryClosedError({
                message: `liveQuery topic "${topic}" was closed before its snapshot was published`,
                topic,
              })
            );
          }
          order.published = ticket;
          return value;
        })
      );
    });
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

  const close = function close() {
    const map = hubs();
    if (map[topic] === hub) {
      Reflect.deleteProperty(map, topic);
    }
    Effect.runSync(PubSub.shutdown(hub));
  };

  return {
    close,
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
