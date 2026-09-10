/* eslint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-unknown-returns -- Worker env / schedule dispatch are trust-boundary bags */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { makeQueueEnvelope, QUEUE_META, toQueueBinding } from "./queue";
import type { QueueHandle } from "./queue";
import { SchemaDecodeError } from "./with-schema";
import {
  createWorkflowInstance,
  toWorkflowBinding,
  WORKFLOW_META,
} from "./workflow";
import type { WorkflowHandle } from "./workflow";

export const SCHEDULE_META = Symbol.for("oxidejs.scheduleMeta");

/** Cloudflare Workers scheduled controller surface. */
export interface ScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
  readonly type?: string;
}

export interface ScheduleEvent {
  cron: string;
  name: string;
  scheduledTime: number;
}

export type ScheduleParams<P> = P | ((event: ScheduleEvent) => P | Promise<P>);

export interface ScheduleDefinition<P = unknown> {
  /** Cron expression (UTC). Emitted into wrangler `triggers.crons`. */
  cron: string;
  /**
   * Escape hatch: own the tick. Exactly one of `workflow` / `queue` /
   * `handle` is required.
   */
  handle?: (
    event: ScheduleEvent,
    env: unknown,
    ctx: unknown
  ) => void | Promise<void>;
  /** Schedule name — used in the idempotent workflow / queue id. */
  name: string;
  /**
   * Params for `workflow.start` / `queue.send`. Taken as-is or from a
   * function of the schedule event. Decoded with the workflow/queue payload
   * schema when present.
   */
  params?: ScheduleParams<P>;
  /** Enqueue one message per tick (then the queue starts its workflow). */
  queue?: QueueHandle<P> | string;
  /** Start this workflow once per tick. */
  workflow?: WorkflowHandle<P> | string;
}

export interface ScheduleMeta<P = unknown> {
  cron: string;
  handle?: ScheduleDefinition<P>["handle"];
  name: string;
  params?: ScheduleParams<P>;
  payload?: Schema.Codec<P, unknown, never, never>;
  /** Copied from `queue({ producerStart })` when the schedule targets a queue. */
  producerStart?: boolean;
  queueBinding?: string;
  queueName?: string;
  workflowBinding?: string;
  workflowName?: string;
}

export interface ScheduleHandle<P = unknown> {
  [SCHEDULE_META]: ScheduleMeta<P>;
}

export const readScheduleMeta = function readScheduleMeta<P = unknown>(
  handle: { [SCHEDULE_META]?: ScheduleMeta<P> } | null | undefined
): ScheduleMeta<P> | undefined {
  return handle?.[SCHEDULE_META];
};

const decodePayload = function decodePayload<P>(
  schema: Schema.Codec<P, unknown, never, never> | undefined,
  value: P
): P {
  if (!schema) {
    return value;
  }
  const decoded = Schema.decodeUnknownResult(schema)(value);
  if (Result.isFailure(decoded)) {
    throw SchemaDecodeError.from(decoded.failure);
  }
  return decoded.success;
};

const resolveWorkflowRef = function resolveWorkflowRef<P>(
  workflow: WorkflowHandle<P> | string
): {
  binding: string;
  name: string;
  payload?: Schema.Codec<P, unknown, never, never>;
} {
  if (typeof workflow === "string") {
    const name = workflow.trim();
    if (!name) {
      throw new Error("oxidejs: schedule({ workflow }) name is empty");
    }
    return { binding: toWorkflowBinding(name), name };
  }
  const meta = workflow[WORKFLOW_META];
  if (!meta) {
    throw new Error(
      "oxidejs: schedule({ workflow }) must be a workflow() handle or name string"
    );
  }
  const out: {
    binding: string;
    name: string;
    payload?: Schema.Codec<P, unknown, never, never>;
  } = { binding: meta.binding, name: meta.name };
  if (meta.payload) {
    // SAFETY: WorkflowHandle<P> meta.payload is Codec<P, …>.
    out.payload = meta.payload as Schema.Codec<P, unknown, never, never>;
  }
  return out;
};

const resolveQueueRef = function resolveQueueRef<P>(
  queue: QueueHandle<P> | string
): {
  binding: string;
  name: string;
  payload?: Schema.Codec<P, unknown, never, never>;
  producerStart?: boolean;
  workflowBinding?: string;
  workflowName?: string;
} {
  if (typeof queue === "string") {
    const name = queue.trim();
    if (!name) {
      throw new Error("oxidejs: schedule({ queue }) name is empty");
    }
    return { binding: toQueueBinding(name), name };
  }
  const meta = queue[QUEUE_META];
  if (!meta) {
    throw new Error(
      "oxidejs: schedule({ queue }) must be a queue() handle or name string"
    );
  }
  const out: {
    binding: string;
    name: string;
    payload?: Schema.Codec<P, unknown, never, never>;
    producerStart?: boolean;
    workflowBinding?: string;
    workflowName?: string;
  } = { binding: meta.binding, name: meta.name };
  if (meta.payload) {
    // SAFETY: QueueHandle<P> meta.payload is Codec<P, …>.
    out.payload = meta.payload as Schema.Codec<P, unknown, never, never>;
  }
  if (meta.producerStart === true) {
    out.producerStart = true;
  }
  if (meta.workflowBinding) {
    out.workflowBinding = meta.workflowBinding;
  }
  if (meta.workflowName) {
    out.workflowName = meta.workflowName;
  }
  return out;
};

const resolveTickParams = async function resolveTickParams<P>(
  meta: ScheduleMeta<P>,
  event: ScheduleEvent
): Promise<P> {
  if (meta.params === undefined) {
    // SAFETY: void / unknown workflows may omit params.
    return undefined as P;
  }
  const { params } = meta;
  if (typeof params === "function") {
    // SAFETY: ScheduleParams function branch — P & Function is excluded by design.
    const fn = params as (event: ScheduleEvent) => P | Promise<P>;
    const raw = await fn(event);
    return decodePayload(meta.payload, raw);
  }
  return decodePayload(meta.payload, params);
};

/** Stable instance / message id for one schedule tick (idempotent retries). */
export const scheduleTickId = function scheduleTickId(
  name: string,
  scheduledTime: number
): string {
  return `${name}-${scheduledTime}`;
};

/**
 * Define a Cloudflare Workers Cron trigger in a `*.server.ts` file. Oxide
 * merges `triggers.crons` into wrangler and attaches a same-worker
 * `scheduled` handler that starts `workflow` (or enqueues / runs `handle`).
 *
 * ```ts
 * export const invoice = workflow({ name: "invoice", payload: Params, run });
 * export const nightly = schedule({
 *   name: "nightly",
 *   cron: "0 3 * * *",
 *   workflow: invoice,
 *   params: { orderId: "batch" },
 * });
 * ```
 *
 * Exactly one of `workflow` / `queue` / `handle` is required. Workflow
 * instance id is `${name}-${scheduledTime}` (letters, digits, `-`, `_` only).
 */
export const schedule = function schedule<P = unknown>(
  def: ScheduleDefinition<P>
): ScheduleHandle<P> {
  const name = def.name.trim();
  if (!name) {
    throw new Error("oxidejs: schedule({ name }) is required");
  }
  const cron = def.cron.trim();
  if (!cron) {
    throw new Error("oxidejs: schedule({ cron }) is required");
  }
  const hasWorkflow = def.workflow !== undefined;
  const hasQueue = def.queue !== undefined;
  const hasHandle = def.handle !== undefined;
  const targets = Number(hasWorkflow) + Number(hasQueue) + Number(hasHandle);
  if (targets !== 1) {
    throw new Error(
      "oxidejs: schedule() requires exactly one of workflow, queue, or handle"
    );
  }

  const meta: ScheduleMeta<P> = { cron, name };
  if (def.params !== undefined) {
    meta.params = def.params;
  }
  if (def.handle) {
    meta.handle = def.handle;
  }
  if (def.workflow !== undefined) {
    const ref = resolveWorkflowRef(def.workflow);
    meta.workflowBinding = ref.binding;
    meta.workflowName = ref.name;
    if (ref.payload) {
      meta.payload = ref.payload;
    }
  }
  if (def.queue !== undefined) {
    const ref = resolveQueueRef(def.queue);
    meta.queueBinding = ref.binding;
    meta.queueName = ref.name;
    if (ref.payload) {
      meta.payload = ref.payload;
    }
    // Optional celld path: schedule→queue can also start the workflow when
    // the queue opts into `producerStart` (same-worker consumer never runs
    // alongside fetch on celld).
    if (ref.producerStart) {
      meta.producerStart = true;
    }
    if (ref.workflowBinding) {
      meta.workflowBinding = ref.workflowBinding;
    }
    if (ref.workflowName) {
      meta.workflowName = ref.workflowName;
    }
  }

  // SAFETY: empty object becomes ScheduleHandle once meta is stamped below.
  const handle = {} as ScheduleHandle<P>;
  handle[SCHEDULE_META] = meta;
  return handle;
};

/**
 * Run every schedule that matches `controller.cron`. Workflow ticks use
 * `${name}-${scheduledTime}` as the instance id.
 */
export const dispatchSchedule = async function dispatchSchedule(
  metas: readonly ScheduleMeta[],
  controller: ScheduledController,
  env: unknown,
  ctx: unknown
): Promise<void> {
  const matched = metas.filter((meta) => meta.cron === controller.cron);
  if (matched.length === 0) {
    throw new Error(
      `oxidejs: no schedule handler for cron ${JSON.stringify(controller.cron)}`
    );
  }
  // SAFETY: Worker env is a binding bag at the schedule boundary.
  const bag = env as Record<
    string,
    | {
        create?: (opts?: {
          id?: string;
          params?: unknown;
        }) => Promise<{ id: string }>;
        get?: (id: string) => Promise<object>;
        send?: (
          body: unknown,
          options?: { contentType?: string; delaySeconds?: number }
        ) => Promise<unknown>;
      }
    | undefined
  >;

  for (const meta of matched) {
    const event: ScheduleEvent = {
      cron: controller.cron,
      name: meta.name,
      scheduledTime: controller.scheduledTime,
    };
    if (meta.handle) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential schedule ticks
      await meta.handle(event, env, ctx);
      continue;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential schedule ticks
    const params = await resolveTickParams(meta, event);
    const id = scheduleTickId(meta.name, controller.scheduledTime);

    if (meta.workflowBinding && !meta.queueBinding) {
      const workflow = bag[meta.workflowBinding];
      if (
        !workflow ||
        typeof workflow.create !== "function" ||
        typeof workflow.get !== "function"
      ) {
        throw new TypeError(
          `oxidejs: workflow binding "${meta.workflowBinding}" is missing for schedule "${meta.name}"`
        );
      }
      // Pass the binding through — extracting `.create` / `.get` drops `this`
      // (celld: TypeError this._create is not a function).
      // SAFETY: create/get narrowed above; keep the host binding as receiver.
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential schedule ticks
      await createWorkflowInstance(
        workflow as {
          create: (opts?: {
            id?: string;
            params?: unknown;
          }) => Promise<{ id: string }>;
          get: (id: string) => Promise<object>;
        },
        { id, params }
      );
      continue;
    }

    if (meta.queueBinding) {
      const queue = bag[meta.queueBinding];
      if (!queue || typeof queue.send !== "function") {
        throw new TypeError(
          `oxidejs: queue binding "${meta.queueBinding}" is missing for schedule "${meta.name}"`
        );
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential schedule ticks
      await queue.send(makeQueueEnvelope(id, params), {
        contentType: "json",
      });
      // Opt-in celld path (`queue({ producerStart: true })`): start the
      // workflow from the schedule tick too (idempotent with a CF consumer).
      if (meta.producerStart && meta.workflowBinding) {
        const workflow = bag[meta.workflowBinding];
        if (
          workflow &&
          typeof workflow.create === "function" &&
          typeof workflow.get === "function"
        ) {
          try {
            // SAFETY: create/get narrowed above; keep the host binding as receiver.
            // oxlint-disable-next-line eslint/no-await-in-loop -- sequential schedule ticks
            await createWorkflowInstance(
              workflow as {
                create: (opts?: {
                  id?: string;
                  params?: unknown;
                }) => Promise<{ id: string }>;
                get: (id: string) => Promise<object>;
              },
              { id, params }
            );
          } catch {
            // Enqueue already succeeded — do not fail the schedule tick.
          }
        }
      }
      continue;
    }

    throw new Error(
      `oxidejs: schedule "${meta.name}" has no workflow, queue, or handle`
    );
  }
};
