import type { ActionContext, ExecutionContext } from "./request-store";
import { runWithRequest } from "./request-store";
import type { OxidejsJson } from "./types";

export type {
  ActionContext,
  ActionContextValue,
  ExecutionContext,
} from "./request-store";
export {
  __setInWebcontainerForTests,
  __setNeedsSyncRequestStoreForTests,
  getRequestStore,
  inWebcontainer,
  needsSyncRequestStore,
  peekRequestStore,
  runWithRequest,
  useCtx,
  useEnv,
  useFetchCtx,
  useIdempotencyKey,
  useRequest,
  withRequestEntry,
  withRequestStore,
} from "./request-store";

const FETCH_KEY = Symbol.for("oxidejs.fetch");

/** Return from `src/server.ts` `fetch` when that entry exists. `undefined` falls through to assets. */
export type FetchResult = Response | undefined;

/**
 * `src/server.ts` fetch handler. The generated wrapper always calls
 * `fetch(request, env, ctx)` — `env` may be `{}` on Node without the `env` option.
 * Return `undefined` (or bare `return`) to fall through to assets.
 */
export type FetchHandler<Env extends object = { [key: string]: OxidejsJson }> =
  (
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ) => FetchResult | Promise<FetchResult>;

/** Default export shape for `src/server.ts`. */
export interface ServerEntry<
  Env extends object = { [key: string]: OxidejsJson },
> {
  fetch: FetchHandler<Env>;
}

type FetchStampRequest = Request & {
  [FETCH_KEY]?: Partial<ActionContext>;
};

/** Merge fields into the request's fetch stamp (middleware, before actions / WS). */
export const stampRequestContext = function stampRequestContext(
  request: Request,
  extra: Partial<ActionContext>
) {
  // SAFETY: Request stamp is oxide-owned under FETCH_KEY; middleware merges Partial<ActionContext>.
  const stamped = request as FetchStampRequest;
  stamped[FETCH_KEY] = { ...stamped[FETCH_KEY], ...extra };
};

/** Current fetch stamp on a Request, if the host has written one. */
export const getRequestContextStamp = function getRequestContextStamp(
  request: Request
): Partial<ActionContext> | undefined {
  // SAFETY: FETCH_KEY slot is only ever Partial<ActionContext> when present.
  return (request as FetchStampRequest)[FETCH_KEY];
};

type RequestStoreHook = <T>(req: Request, fn: () => T) => T;

const HOOK_KEY = Symbol.for("oxidejs.runWithRequest");
// SAFETY: HOOK_KEY is oxide-owned; the slot is only ever RequestStoreHook.
const hookGlobal = globalThis as typeof globalThis & {
  [HOOK_KEY]?: RequestStoreHook;
};
hookGlobal[HOOK_KEY] ??= function oxideRunWithRequest<T>(
  req: Request,
  fn: () => T
): T {
  // SAFETY: fetch host stamps Partial<ActionContext> on Request under FETCH_KEY before dispatch.
  const stamped = req as Request & { [FETCH_KEY]?: Partial<ActionContext> };
  return runWithRequest(req, fn, stamped[FETCH_KEY]);
};

export {
  action,
  brandServerAction,
  wrapClientRpc,
  wrapClientStreamRpc,
  ACTION_CALL,
  ACTION_META,
  readActionMeta,
  writeActionMeta,
  WITH_SCHEMA_PAYLOAD,
} from "./action";
export type {
  ActionMeta,
  ActionOptions,
  CallOptions,
  ServerActionHandle,
  StreamActionHandle,
} from "./action";
export { liveQuery, publish } from "./live-query";
export type { LiveQuery, LiveQueryOptions } from "./live-query";
export { oxideRuntimeLayer } from "./runtime";
export type { OxideRuntimeOptions } from "./runtime";
export {
  actionResultToStream,
  runActionEffect,
  runActionInContext,
} from "./run-action";
export { actionContextLayer, OxideCtx, OxideRequest } from "./services";
export { SchemaDecodeError, withSchema } from "./with-schema";
export {
  dispatchQueueBatch,
  isQueueEnvelope,
  makeQueueEnvelope,
  queue,
  QUEUE_META,
  OXIDE_QUEUE_ENVELOPE,
  readQueueEnvelope,
  readQueueMeta,
  toQueueBinding,
} from "./queue";
export type {
  QueueDefinition,
  QueueEnvelope,
  QueueHandle,
  QueueMessage,
  QueueMessageBatch,
  QueueMessageSendRequest,
  QueueMeta,
  QueueSendBatchResult,
  QueueSendOptions,
  QueueSendResult,
} from "./queue";
export {
  dispatchSchedule,
  readScheduleMeta,
  schedule,
  SCHEDULE_META,
  scheduleTickId,
} from "./schedule";
export type {
  ScheduleDefinition,
  ScheduleEvent,
  ScheduleHandle,
  ScheduleMeta,
  ScheduleParams,
  ScheduledController,
} from "./schedule";
export {
  readWorkflowMeta,
  toWorkflowBinding,
  toWorkflowClassName,
  WORKFLOW_META,
  workflow,
} from "./workflow";
export type {
  WorkflowDefinition,
  WorkflowHandle,
  WorkflowInstanceStatus,
  WorkflowMeta,
  WorkflowRunContext,
  WorkflowRunEvent,
  WorkflowSendEvent,
  WorkflowStartResult,
  WorkflowStep,
  WorkflowStepConfig,
} from "./workflow";
export {
  buildOpenRpcDocument,
  codecToJsonSchema,
  createOpenRpcResponse,
  matchesOpenRpcPath,
  OPENRPC_PATH,
} from "./openrpc";
export type {
  BuildOpenRpcDocumentOptions,
  OpenRpcActionEntry,
} from "./openrpc";
