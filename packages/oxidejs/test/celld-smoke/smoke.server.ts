/**
 * Smoke actions, compiled by oxide's own codegen (as an app's `*.server.ts`
 * files are), so the celld run covers the generated handlers,
 * `runActionInContext` and user-level `useRequest()` after an `await`.
 */
import { Effect } from "effect";

import { action, useRequest } from "../../src/context";

const WORK_MS = 20;

const delay = (ms: number) =>
  // oxlint-disable-next-line promise/avoid-new -- a timer-backed delay
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const ping = action(async () => {
  await Promise.resolve();
  return "pong";
});

export const work = action(async () => {
  await delay(WORK_MS);
  return "done";
});

/** Reads the request after an await, the way app code reads its session. */
export const whoami = action(async () => {
  await delay(WORK_MS);
  return useRequest().headers.get("x-user") ?? "none";
});

// Never settles: only the action timeout can answer it.
export const stall = action(async () => {
  await Effect.runPromise(Effect.never);
  return "unreachable";
});
