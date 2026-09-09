/* eslint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-unknown-returns -- Worker env / CallOptions peel are trust-boundary bags */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { CallOptions } from "./action";
import { useEnv, useIdempotencyKey } from "./request-store";
import { SchemaDecodeError } from "./with-schema";
import {
  createWorkflowInstanceBatch,
  toWorkflowBinding,
  WORKFLOW_META,
} from "./workflow";
import type { WorkflowCreateOptions, WorkflowHandle } from "./workflow";

export const QUEUE_META = Symbol.for("oxidejs.queueMeta");

/** Wire marker so consumers can unwrap client-chosen workflow instance ids. */
export const OXIDE_QUEUE_ENVELOPE = "oxidejs.queue" as const;

export interface QueueSendOptions {
  contentType?: string;
  delaySeconds?: number;
}

export interface QueueMessageSendRequest<P = unknown> {
  body: P;
  contentType?: string;
  delaySeconds?: number;
  /** Stable workflow instance id for this message. Default: random UUID. */
  idempotencyKey?: string;
}

/** Minimal consumer batch surface shared with Cloudflare Queues. */
export interface QueueMessage<P = unknown> {
  readonly id: string;
  readonly body: P;
  readonly timestamp: Date;
  ack: () => void;
  retry: (options?: { delaySeconds?: number }) => void;
}

export interface QueueMessageBatch<P = unknown> {
  readonly queue: string;
  readonly messages: readonly QueueMessage<P>[];
  ackAll: () => void;
  retryAll: (options?: { delaySeconds?: number }) => void;
}

export interface QueueDefinition<P> {
  /** Env producer binding. Default: UPPER_SNAKE from `name`. */
  binding?: string;
  /**
   * Escape hatch: own the consumer. When set, oxide does not auto-start
   * `workflow` for each message. Batches still use oxide envelopes from
   * `send` / `sendBatch` — unwrap with `readQueueEnvelope`.
   */
  handle?: (
    batch: QueueMessageBatch<P>,
    env: unknown,
    ctx: unknown
  ) => void | Promise<void>;
  maxBatchSize?: number;
  maxBatchTimeout?: number;
  maxRetries?: number;
  /** Queue name (wrangler `queue` + Rpc prefix). */
  name: string;
  /**
   * When true, `send` / `sendBatch` also start the workflow from the producer
   * (same envelope id). Opt in for celld, which does not run same-worker queue
   * consumers alongside `fetch()`. Default `false` so Cloudflare queue
   * semantics (backpressure, batching, retries) control execution.
   */
  producerStart?: boolean;
  /**
   * Workflow to start per message. Instance id is the client-chosen envelope
   * id (from `{ idempotencyKey }` / request header / UUID) — CF does not
   * return message ids from `send`. Payload schema is taken from the
   * workflow handle (pass a `workflow()` handle, not only a name string).
   */
  workflow: WorkflowHandle<P> | string;
}

export interface QueueSendResult {
  id: string;
}

export interface QueueSendBatchResult {
  ids: string[];
}

export interface QueueHandle<P> {
  send: (
    body: P,
    opts?: QueueSendOptions & CallOptions
  ) => Promise<QueueSendResult>;
  sendBatch: (
    messages: Iterable<QueueMessageSendRequest<P>>,
    opts?: QueueSendOptions & CallOptions
  ) => Promise<QueueSendBatchResult>;
  [QUEUE_META]: QueueMeta<P>;
}

export interface QueueMeta<P = unknown> {
  binding: string;
  handle?: QueueDefinition<P>["handle"];
  maxBatchSize?: number;
  maxBatchTimeout?: number;
  maxRetries?: number;
  name: string;
  payload?: Schema.Codec<P, unknown, never, never>;
  /** See {@link QueueDefinition.producerStart}. */
  producerStart?: boolean;
  workflowBinding: string;
  workflowName: string;
}

/** Body written by oxide `send` / `sendBatch` for workflow-backed queues. */
export interface QueueEnvelope<P = unknown> {
  id: string;
  oxide: typeof OXIDE_QUEUE_ENVELOPE;
  payload: P;
}

interface QueueBinding {
  send: (body: unknown, options?: QueueSendOptions) => Promise<unknown>;
  sendBatch: (
    messages: Iterable<QueueMessageSendRequest>,
    options?: QueueSendOptions
  ) => Promise<unknown>;
}

interface PeeledArgs {
  args: unknown[];
  options?: CallOptions & QueueSendOptions;
}

export const toQueueBinding = function toQueueBinding(name: string) {
  return name
    .replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, "$<lower>_$<upper>")
    .replaceAll(/[^a-zA-Z0-9]+/gu, "_")
    .replaceAll(/^_|_$/gu, "")
    .toUpperCase();
};

export const readQueueMeta = function readQueueMeta<P = unknown>(
  handle: { [QUEUE_META]?: QueueMeta<P> } | null | undefined
): QueueMeta<P> | undefined {
  return handle?.[QUEUE_META];
};

const OPTION_KEYS = new Set([
  "signal",
  "idempotencyKey",
  "contentType",
  "delaySeconds",
]);

const isCallOptionsBag = function isCallOptionsBag(
  value: unknown
): value is CallOptions & QueueSendOptions {
  if (value === null || Array.isArray(value) || !(value instanceof Object)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > 4) {
    return false;
  }
  for (const key of keys) {
    if (!OPTION_KEYS.has(key)) {
      return false;
    }
  }
  // SAFETY: keys are only CallOptions / QueueSendOptions fields.
  const bag = value as CallOptions & QueueSendOptions;
  if ("signal" in bag && !(bag.signal instanceof AbortSignal)) {
    return false;
  }
  if (
    "idempotencyKey" in bag &&
    bag.idempotencyKey !== undefined &&
    typeof bag.idempotencyKey !== "string"
  ) {
    return false;
  }
  if (
    "contentType" in bag &&
    bag.contentType !== undefined &&
    typeof bag.contentType !== "string"
  ) {
    return false;
  }
  if (
    "delaySeconds" in bag &&
    bag.delaySeconds !== undefined &&
    typeof bag.delaySeconds !== "number"
  ) {
    return false;
  }
  return true;
};

const peelTrailingOptions = function peelTrailingOptions(
  args: unknown[]
): PeeledArgs {
  if (args.length === 0) {
    return { args };
  }
  const last = args.at(-1);
  if (!isCallOptionsBag(last)) {
    return { args };
  }
  return {
    args: args.slice(0, -1),
    options: last,
  };
};

const sendOptsFrom = function sendOptsFrom(
  options: (CallOptions & QueueSendOptions) | undefined
): QueueSendOptions | undefined {
  if (!options) {
    return;
  }
  const out: QueueSendOptions = {};
  if (options.contentType !== undefined) {
    out.contentType = options.contentType;
  }
  if (options.delaySeconds !== undefined) {
    out.delaySeconds = options.delaySeconds;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const requireBinding = function requireBinding(binding: string): QueueBinding {
  // SAFETY: Worker env is a binding bag; we validate send/sendBatch below.
  const env = useEnv() as Record<string, QueueBinding | undefined> | undefined;
  const value = env?.[binding];
  if (
    value === null ||
    value === undefined ||
    typeof value.send !== "function" ||
    typeof value.sendBatch !== "function"
  ) {
    throw new TypeError(
      `oxidejs: queue binding "${binding}" is missing — use preset: "worker" and ensure wrangler queues were emitted`
    );
  }
  return value;
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
      throw new Error("oxidejs: queue({ workflow }) name is empty");
    }
    return { binding: toWorkflowBinding(name), name };
  }
  // SAFETY: stamped by workflow(); avoid variance clash with WorkflowMeta<unknown>.
  const meta = workflow[WORKFLOW_META];
  if (!meta) {
    throw new Error(
      "oxidejs: queue({ workflow }) must be a workflow() handle or name string"
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

export const isQueueEnvelope = function isQueueEnvelope(
  value: unknown
): value is QueueEnvelope {
  if (value === null || Array.isArray(value) || !(value instanceof Object)) {
    return false;
  }
  // SAFETY: shape-checked below.
  const bag = value as { id?: unknown; oxide?: unknown; payload?: unknown };
  return (
    bag.oxide === OXIDE_QUEUE_ENVELOPE &&
    typeof bag.id === "string" &&
    bag.id.length > 0 &&
    "payload" in bag
  );
};

/** Unwrap an oxide `send` body, or treat a raw CF message body as payload. */
export const readQueueEnvelope = function readQueueEnvelope<P = unknown>(
  body: unknown,
  fallbackId: string
): { id: string; payload: P } {
  if (isQueueEnvelope(body)) {
    // SAFETY: payload is P at the producer decode boundary.
    return { id: body.id, payload: body.payload as P };
  }
  // SAFETY: non-envelope bodies are the payload as published.
  return { id: fallbackId, payload: body as P };
};

export const makeQueueEnvelope = function makeQueueEnvelope<P>(
  id: string,
  payload: P
): QueueEnvelope<P> {
  return { id, oxide: OXIDE_QUEUE_ENVELOPE, payload };
};

const nextMessageId = function nextMessageId(
  options: (CallOptions & QueueSendOptions) | undefined,
  perMessage?: string
): string {
  return (
    perMessage ??
    options?.idempotencyKey ??
    useIdempotencyKey() ??
    crypto.randomUUID()
  );
};

interface WorkflowEnvBinding {
  create?: (opts?: WorkflowCreateOptions) => Promise<{ id: string }>;
  createBatch?: (batch: WorkflowCreateOptions[]) => Promise<{ id: string }[]>;
  get?: (id: string) => Promise<object>;
}

interface WorkflowBinding {
  create: (opts?: WorkflowCreateOptions) => Promise<{ id: string }>;
  createBatch?: (batch: WorkflowCreateOptions[]) => Promise<{ id: string }[]>;
  get: (id: string) => Promise<object>;
}

/**
 * Opt-in celld path: start the workflow from the producer (idempotent with the
 * CF consumer via create-or-get). Skip when `delaySeconds` is set — delayed
 * delivery still needs a real consumer.
 */
const startWorkflowFromProducer = async function startWorkflowFromProducer(
  meta: { handle?: unknown; workflowBinding: string },
  starts: WorkflowCreateOptions[],
  delaySeconds: number | undefined
) {
  if (meta.handle || starts.length === 0) {
    return;
  }
  if (delaySeconds !== undefined && delaySeconds > 0) {
    return;
  }
  // SAFETY: Worker env is a binding bag; validate create/get below.
  const env = useEnv() as
    | Record<string, WorkflowEnvBinding | undefined>
    | undefined;
  const workflow = env?.[meta.workflowBinding];
  if (
    !workflow ||
    typeof workflow.create !== "function" ||
    typeof workflow.get !== "function"
  ) {
    return;
  }
  // Pass the binding through — extracting `.create` / `.get` drops `this`
  // (celld: TypeError this._create is not a function).
  // SAFETY: create/get narrowed above; keep the host binding as receiver.
  await createWorkflowInstanceBatch(workflow as WorkflowBinding, starts);
};

/**
 * Define a Cloudflare Workers Queue in a `*.server.ts` file. Oxide emits
 * producer + consumer wrangler entries and a same-worker `queue` handler that
 * starts `workflow` once per message.
 *
 * ```ts
 * export const invoice = workflow({ name: "invoice", payload: Params, run });
 * export const invoices = queue({
 *   name: "invoices",
 *   workflow: invoice,
 * });
 *
 * const { id } = await invoices.send({ orderId: "…" });
 * await invoice.status(id);
 * ```
 *
 * Cloudflare does not return message ids from `send`, so oxide wraps each
 * body in an envelope with a client-chosen id (`idempotencyKey` / UUID) and
 * returns that id for workflow polling. `send` / `sendBatch` decode with the
 * workflow's `payload` schema.
 *
 * celld does not deliver to a consumer that shares a Worker with `fetch()`.
 * Set `producerStart: true` so `send` / `sendBatch` also start the workflow
 * from the producer (same id). Default is off so Cloudflare queue semantics
 * control execution. Delayed messages (`delaySeconds`) still need a consumer.
 */
export const queue = function queue<P>(
  def: QueueDefinition<P>
): QueueHandle<P> {
  const name = def.name.trim();
  if (!name) {
    throw new Error("oxidejs: queue({ name }) is required");
  }
  const binding = def.binding ?? toQueueBinding(name);
  const workflowRef = resolveWorkflowRef(def.workflow);
  const meta: QueueMeta<P> = {
    binding,
    name,
    workflowBinding: workflowRef.binding,
    workflowName: workflowRef.name,
  };
  if (workflowRef.payload) {
    meta.payload = workflowRef.payload;
  }
  if (def.handle) {
    meta.handle = def.handle;
  }
  if (def.producerStart === true) {
    meta.producerStart = true;
  }
  if (def.maxBatchSize !== undefined) {
    meta.maxBatchSize = def.maxBatchSize;
  }
  if (def.maxBatchTimeout !== undefined) {
    meta.maxBatchTimeout = def.maxBatchTimeout;
  }
  if (def.maxRetries !== undefined) {
    meta.maxRetries = def.maxRetries;
  }

  const send = async (
    ...allArgs: [P] | [P, QueueSendOptions & CallOptions]
  ): Promise<QueueSendResult> => {
    const { args, options } = peelTrailingOptions(allArgs);
    // SAFETY: send always receives body as first arg after peel.
    const raw = args[0] as P;
    const decoded = decodePayload(meta.payload, raw);
    const id = nextMessageId(options);
    const q = requireBinding(binding);
    const sendOpts = { contentType: "json", ...sendOptsFrom(options) };
    await q.send(makeQueueEnvelope(id, decoded), sendOpts);
    if (meta.producerStart) {
      try {
        await startWorkflowFromProducer(
          meta,
          [{ id, params: decoded }],
          sendOpts.delaySeconds
        );
      } catch {
        // Enqueue already succeeded — do not fail the client / cause a resend.
      }
    }
    return { id };
  };

  const sendBatch = async (
    ...allArgs:
      | [Iterable<QueueMessageSendRequest<P>>]
      | [Iterable<QueueMessageSendRequest<P>>, QueueSendOptions & CallOptions]
  ): Promise<QueueSendBatchResult> => {
    const { args, options } = peelTrailingOptions(allArgs);
    // SAFETY: sendBatch always receives messages iterable first.
    const messages = args[0] as Iterable<QueueMessageSendRequest<P>>;
    const ids: string[] = [];
    const decoded: QueueMessageSendRequest[] = [];
    const starts: WorkflowCreateOptions[] = [];
    let anyDelay = false;
    const batchOpts = sendOptsFrom(options);
    if (batchOpts?.delaySeconds !== undefined && batchOpts.delaySeconds > 0) {
      anyDelay = true;
    }
    for (const message of messages) {
      const id = nextMessageId(options, message.idempotencyKey);
      ids.push(id);
      const payload = decodePayload(meta.payload, message.body);
      const entry: QueueMessageSendRequest = {
        body: makeQueueEnvelope(id, payload),
        contentType: message.contentType ?? "json",
      };
      if (message.delaySeconds !== undefined) {
        entry.delaySeconds = message.delaySeconds;
        if (message.delaySeconds > 0) {
          anyDelay = true;
        }
      }
      decoded.push(entry);
      starts.push({ id, params: payload });
    }
    const q = requireBinding(binding);
    await q.sendBatch(decoded, batchOpts);
    if (meta.producerStart) {
      try {
        await startWorkflowFromProducer(meta, starts, anyDelay ? 1 : undefined);
      } catch {
        // Enqueue already succeeded — do not fail the client / cause a resend.
      }
    }
    return { ids };
  };

  const handle = { send, sendBatch };
  // SAFETY: install oxide-owned meta on the callable handle object.
  (handle as QueueHandle<P>)[QUEUE_META] = meta;
  // SAFETY: handle methods match QueueHandle; meta stamped above.
  return handle as QueueHandle<P>;
};

/**
 * Default consumer: start the bound workflow for each message using the
 * envelope id (idempotent retries of the same CF message keep the same body).
 */
export const dispatchQueueBatch = async function dispatchQueueBatch(
  meta: QueueMeta,
  batch: QueueMessageBatch,
  env: unknown,
  ctx: unknown
): Promise<void> {
  if (meta.handle) {
    await meta.handle(batch, env, ctx);
    return;
  }
  // SAFETY: Worker env is a binding bag at the queue/workflow boundary.
  const bag = env as Record<
    string,
    | {
        create?: (opts?: WorkflowCreateOptions) => Promise<{ id: string }>;
        createBatch?: (
          batch: WorkflowCreateOptions[]
        ) => Promise<{ id: string }[]>;
        get?: (id: string) => Promise<object>;
      }
    | undefined
  >;
  const workflow = bag[meta.workflowBinding];
  if (
    !workflow ||
    typeof workflow.create !== "function" ||
    typeof workflow.get !== "function"
  ) {
    throw new TypeError(
      `oxidejs: workflow binding "${meta.workflowBinding}" is missing for queue "${meta.name}"`
    );
  }
  const starts: WorkflowCreateOptions[] = batch.messages.map((message) => {
    const { id, payload } = readQueueEnvelope(message.body, message.id);
    return { id, params: payload };
  });
  // Pass the binding through — extracting methods drops `this` on celld/workerd.
  // SAFETY: create/get narrowed above; keep the host binding as receiver.
  await createWorkflowInstanceBatch(workflow as WorkflowBinding, starts);
};
