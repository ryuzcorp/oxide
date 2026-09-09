import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { ActionContext } from "./request-store";
import {
  enterRequestStore,
  exitRequestStore,
  runWithAls,
} from "./request-store";
import {
  asyncGenToStream,
  bindAsyncGenContext,
  bindAsyncIterableContext,
} from "./rpc/stream";
import { actionContextLayer } from "./services";
import type { OxidejsJson } from "./types";

type ActionValue = OxidejsJson | Response | null | undefined;

interface Thenable {
  then: (
    onfulfilled?:
      | ((value: ActionValue) => ActionValue | PromiseLike<ActionValue>)
      | null,
    onrejected?:
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise.then rejection channel
      ((error: unknown) => ActionValue | PromiseLike<ActionValue>) | null
  ) => PromiseLike<ActionValue>;
}

const isPromiseLike = function isPromiseLike(
  value:
    | ActionValue
    | Promise<ActionValue>
    | Effect.Effect<ActionValue>
    | Thenable
): value is Thenable {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value !== "object" && typeof value !== "function") {
    return false;
  }
  // SAFETY: object/function branch above; thenable is detected by a callable `then`.
  return typeof (value as Thenable).then === "function";
};

const rejectResponse = function rejectResponse(
  value: ActionValue
): OxidejsJson | null {
  if (value instanceof Response) {
    console.error(
      "oxidejs: action() returned a Response; actions must return serializable data. Return a Response from src/server.ts for raw HTTP responses."
    );
    throw new Error(
      "action() returned a Response; return it from src/server.ts instead"
    );
  }
  return value === undefined ? null : value;
};

const asDefect = function asDefect(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
};

const withActionSpan = function withActionSpan<A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>
) {
  return effect.pipe(
    Effect.withSpan("oxidejs.action", {
      attributes: { "rpc.method": method },
    }),
    Effect.annotateLogs({ "rpc.method": method })
  );
};

/**
 * Turn a Promise / Effect / plain value into an Effect for Rpc handlers.
 * Annotates a span + logs. Callers should `Effect.provide(actionContextLayer(ctx))`.
 */
export const runActionEffect = function runActionEffect(
  method: string,
  fn: () => ActionValue | Promise<ActionValue> | Effect.Effect<ActionValue>
): Effect.Effect<OxidejsJson | null, Error> {
  return Effect.suspend(() => {
    const raw = fn();
    if (Effect.isEffect(raw)) {
      // SAFETY: Effect.isEffect narrows to Effect; success channel is ActionValue.
      return raw as Effect.Effect<ActionValue, Error>;
    }
    return Effect.tryPromise({
      catch: asDefect,
      try: () => Promise.resolve(raw),
    });
  }).pipe(Effect.map(rejectResponse), (effect) =>
    withActionSpan(method, effect)
  );
};

/**
 * Provide request services + keep the Worker sync store for the whole handler.
 *
 * `withRequestStore` only defers restore for Promise returns. Effect handlers
 * return an Effect synchronously, so wrapping them in `withRequestStore` clears
 * `useDb()` / `useEnv()` before the fiber runs — breaks kit mutations on celld.
 */
export const runActionInContext = function runActionInContext(
  method: string,
  ctx: ActionContext,
  fn: () => ActionValue | Promise<ActionValue> | Effect.Effect<ActionValue>
): Effect.Effect<OxidejsJson | null, Error> {
  return Effect.suspend(() => {
    const previous = enterRequestStore(ctx);
    let raw: ActionValue | Promise<ActionValue> | Effect.Effect<ActionValue>;
    try {
      raw = runWithAls(ctx, fn);
    } catch (error) {
      exitRequestStore(ctx, previous);
      throw error;
    }

    if (Effect.isEffect(raw)) {
      return Effect.ensuring(
        // SAFETY: Effect.isEffect narrowed; success channel is ActionValue.
        (raw as Effect.Effect<ActionValue, Error>).pipe(
          Effect.map(rejectResponse)
        ),
        Effect.sync(() => exitRequestStore(ctx, previous))
      );
    }

    if (isPromiseLike(raw)) {
      return Effect.tryPromise({
        catch: asDefect,
        try: async () => {
          try {
            return rejectResponse(await raw);
          } finally {
            exitRequestStore(ctx, previous);
          }
        },
      });
    }

    exitRequestStore(ctx, previous);
    return Effect.succeed(rejectResponse(raw));
  }).pipe(
    (effect) => withActionSpan(method, effect),
    Effect.provide(actionContextLayer(ctx))
  );
};

/**
 * Normalize an action return into an Effect Stream for Rpc `stream: true`.
 * Accepts async generators or Effect Streams.
 *
 * Effect Streams (including `Stream.unwrap`) are drained through the same ALS
 * re-entry as async generators so `useDb()` / `useEnv()` work on Workers when
 * the unwrap Effect runs on first pull.
 */
export const actionResultToStream = function actionResultToStream(
  method: string,
  ctx: ActionContext,
  create: () =>
    | AsyncGenerator<ActionValue, unknown, unknown>
    | Stream.Stream<ActionValue, Error>,
  run: <R>(fn: () => R) => R
): Stream.Stream<OxidejsJson | null, Error> {
  const raw = run(create);
  const sourced = Stream.isStream(raw)
    ? asyncGenToStream(
        bindAsyncIterableContext(
          Stream.toAsyncIterable(
            // SAFETY: Stream.isStream narrowed `raw`; provide request services for unwrap Effects.
            (raw as Stream.Stream<ActionValue, Error>).pipe(
              Stream.provide(actionContextLayer(ctx))
            )
          ),
          run
        )
      )
    : asyncGenToStream(
        // SAFETY: non-Stream branch is the async generator create() returned.
        bindAsyncGenContext(
          raw as AsyncGenerator<ActionValue, unknown, unknown>,
          run
        )
      );
  return sourced.pipe(
    Stream.map(rejectResponse),
    Stream.withSpan("oxidejs.action", {
      attributes: { "rpc.method": method },
    })
  );
};
