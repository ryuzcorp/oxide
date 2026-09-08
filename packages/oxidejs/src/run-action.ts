import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { ActionContext } from "./request-store";
import { asyncGenToStream, bindAsyncGenContext } from "./rpc/stream";
import { actionContextLayer } from "./services";
import type { OxidejsJson } from "./types";

type ActionValue = OxidejsJson | Response | null | undefined;

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
  }).pipe(
    Effect.map(rejectResponse),
    Effect.withSpan("oxidejs.action", {
      attributes: { "rpc.method": method },
    }),
    Effect.annotateLogs({ "rpc.method": method })
  );
};

/** Provide request services around `runActionEffect` for generated handlers. */
export const runActionInContext = function runActionInContext(
  method: string,
  ctx: ActionContext,
  fn: () => ActionValue | Promise<ActionValue> | Effect.Effect<ActionValue>
): Effect.Effect<OxidejsJson | null, Error> {
  return runActionEffect(method, fn).pipe(
    Effect.provide(actionContextLayer(ctx))
  );
};

/**
 * Normalize an action return into an Effect Stream for Rpc `stream: true`.
 * Accepts async generators or Effect Streams.
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
  // SAFETY: Stream.isStream narrows; otherwise the action is an async generator.
  const stream = Stream.isStream(raw)
    ? (raw as Stream.Stream<ActionValue, Error>)
    : asyncGenToStream(
        bindAsyncGenContext(
          raw as AsyncGenerator<ActionValue, unknown, unknown>,
          run
        )
      );
  return stream.pipe(
    Stream.map(rejectResponse),
    Stream.withSpan("oxidejs.action", {
      attributes: { "rpc.method": method },
    }),
    Stream.provide(actionContextLayer(ctx))
  );
};
