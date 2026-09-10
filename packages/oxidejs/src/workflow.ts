/* eslint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening -- Worker env / CallOptions peel are trust-boundary bags */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { CallOptions } from "./action";
import { useEnv, useIdempotencyKey } from "./request-store";
import { SchemaDecodeError } from "./with-schema";

export const WORKFLOW_META = Symbol.for("oxidejs.workflowMeta");

/** Minimal step surface shared with Cloudflare Workflows (passed through at runtime). */
export interface WorkflowStepConfig {
  retries?: {
    backoff?: "constant" | "linear" | "exponential";
    delay: string | number;
    limit: number;
  };
}

export interface WorkflowStep {
  do: {
    <T>(name: string, callback: () => T | Promise<T>): Promise<T>;
    <T>(
      name: string,
      config: WorkflowStepConfig,
      callback: () => T | Promise<T>
    ): Promise<T>;
  };
  sleep: (name: string, duration: string | number) => Promise<void>;
  sleepUntil: (name: string, timestamp: Date | number) => Promise<void>;
  waitForEvent: <T = unknown>(
    name: string,
    options: { timeout?: string | number; type: string }
  ) => Promise<T>;
}

export interface WorkflowRunEvent<P> {
  instanceId: string;
  payload: P;
  timestamp: Date;
  workflowName?: string;
}

export interface WorkflowDefinition<P, R = unknown> {
  /** Env binding. Default: UPPER_SNAKE from `name`. */
  binding?: string;
  /** Exported Worker class name. Default: `PascalCase(name) + "Workflow"`. */
  className?: string;
  /** Workflow name (wrangler `name` + Rpc prefix). */
  name: string;
  /** Decode `start` params (Encoded in, Type out). */
  payload?: Schema.Codec<P, unknown, never, never>;
  run: (event: WorkflowRunEvent<P>, step: WorkflowStep) => R | Promise<R>;
}

export interface WorkflowInstanceStatus {
  error?: { message?: string; name?: string };
  output?: unknown;
  status: string;
}

export interface WorkflowStartResult {
  id: string;
}

export interface WorkflowSendEvent {
  payload?: unknown;
  type: string;
}

export interface WorkflowHandle<P, R = unknown> {
  send: (
    id: string,
    event: WorkflowSendEvent,
    opts?: CallOptions
  ) => Promise<void>;
  start: (params: P, opts?: CallOptions) => Promise<WorkflowStartResult>;
  status: (id: string, opts?: CallOptions) => Promise<WorkflowInstanceStatus>;
  [WORKFLOW_META]: WorkflowMeta<P, R>;
}

export interface WorkflowMeta<P = unknown, R = unknown> {
  binding: string;
  className: string;
  name: string;
  payload?: Schema.Codec<P, unknown, never, never>;
  run: WorkflowDefinition<P, R>["run"];
}

export interface WorkflowCreateOptions {
  id?: string;
  params?: unknown;
}

interface WorkflowBinding {
  create: (opts?: WorkflowCreateOptions) => Promise<{ id: string }>;
  /** Idempotent batch create — skips ids that already exist (Cloudflare). */
  createBatch?: (batch: WorkflowCreateOptions[]) => Promise<{ id: string }[]>;
  get: (id: string) => Promise<{
    sendEvent: (event: WorkflowSendEvent) => Promise<void>;
    status: () => Promise<WorkflowInstanceStatus>;
  }>;
}

interface PeeledArgs {
  args: unknown[];
  options?: CallOptions;
}

export const toWorkflowBinding = function toWorkflowBinding(name: string) {
  return name
    .replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, "$<lower>_$<upper>")
    .replaceAll(/[^a-zA-Z0-9]+/gu, "_")
    .replaceAll(/^_|_$/gu, "")
    .toUpperCase();
};

export const toWorkflowClassName = function toWorkflowClassName(name: string) {
  const pascal = name
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return pascal.endsWith("Workflow") ? pascal : `${pascal}Workflow`;
};

export const readWorkflowMeta = function readWorkflowMeta(
  handle: { [WORKFLOW_META]?: WorkflowMeta } | null | undefined
): WorkflowMeta | undefined {
  return handle?.[WORKFLOW_META];
};

const isCallOptionsBag = function isCallOptionsBag(
  value: unknown
): value is CallOptions {
  if (value === null || Array.isArray(value) || !(value instanceof Object)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > 2) {
    return false;
  }
  for (const key of keys) {
    if (key !== "signal" && key !== "idempotencyKey") {
      return false;
    }
  }
  // SAFETY: keys are only CallOptions fields; validate value shapes next.
  const bag = value as CallOptions;
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
  return "signal" in bag || "idempotencyKey" in bag;
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

const requireBinding = function requireBinding(
  binding: string
): WorkflowBinding {
  // SAFETY: Worker env is a binding bag; we validate create/get below.
  const env = useEnv() as
    | Record<string, WorkflowBinding | undefined>
    | undefined;
  const value = env?.[binding];
  if (
    value === null ||
    value === undefined ||
    typeof value.create !== "function" ||
    typeof value.get !== "function"
  ) {
    throw new TypeError(
      `oxidejs: workflow binding "${binding}" is missing — use preset: "worker" and ensure wrangler workflows were merged`
    );
  }
  return value;
};

/** Flatten CF / host throwables into searchable text (`instance.not_found`, etc.). */
export const workflowErrorText = function workflowErrorText(
  error: unknown
): string {
  if (error instanceof Error) {
    return `${error.name} ${error.message}`;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    // SAFETY: host throwables are plain bags with optional name/message/code.
    const bag = error as { code?: unknown; message?: unknown; name?: unknown };
    return [bag.name, bag.message, bag.code].filter(Boolean).join(" ");
  }
  return String(error);
};

/** CF `create({ id })` throws when the id already exists within retention. */
export const isWorkflowIdConflict = function isWorkflowIdConflict(
  error: unknown
): boolean {
  const message = workflowErrorText(error);
  return (
    /already exists/iu.test(message) ||
    /instance.*exist/iu.test(message) ||
    /duplicate/iu.test(message)
  );
};

/** CF `Workflow.get` / `status` when the instance id is missing or not ready yet. */
export const isWorkflowInstanceMissing = function isWorkflowInstanceMissing(
  error: unknown
): boolean {
  const message = workflowErrorText(error);
  return (
    /not[_ ]?found/iu.test(message) ||
    /does not exist/iu.test(message) ||
    /unknown.?instance/iu.test(message)
  );
};

/**
 * Plain JSON status for Rpc. CF host objects / `error: null` / `rollback`
 * must not leak into Schema encode (Defect → "Internal error" on the client).
 */
export const normalizeWorkflowStatus = function normalizeWorkflowStatus(
  raw: unknown
): WorkflowInstanceStatus {
  if (raw === null || typeof raw !== "object") {
    return { status: "unknown" };
  }
  // SAFETY: InstanceStatus is a plain bag; read known fields only.
  const bag = raw as {
    error?: unknown;
    output?: unknown;
    status?: unknown;
  };
  const out: WorkflowInstanceStatus = {
    status: typeof bag.status === "string" ? bag.status : "unknown",
  };
  if (bag.output !== undefined && bag.output !== null) {
    try {
      // Re-hydrate through JSON so Rpc never sees host proxies.
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON strips CF host values
      out.output = JSON.parse(JSON.stringify(bag.output));
    } catch {
      out.output = bag.output;
    }
  }
  if (
    bag.error !== undefined &&
    bag.error !== null &&
    typeof bag.error === "object"
  ) {
    // SAFETY: narrowed to object; CF error bags expose optional message/name strings.
    const e = bag.error as { message?: unknown; name?: unknown };
    out.error = {};
    if (typeof e.message === "string") {
      out.error.message = e.message;
    }
    if (typeof e.name === "string") {
      out.error.name = e.name;
    }
  }
  return out;
};

/**
 * Start a workflow instance. Retries / redelivery with the same `id` reuse the
 * existing instance instead of failing (`create` is not idempotent on CF).
 */
export const createWorkflowInstance = async function createWorkflowInstance(
  wf: {
    create: (opts?: WorkflowCreateOptions) => Promise<{ id: string }>;
    get: (id: string) => Promise<{ id?: string } | object>;
  },
  opts: WorkflowCreateOptions
): Promise<{ id: string }> {
  try {
    return await wf.create(opts);
  } catch (error) {
    if (!(opts.id && isWorkflowIdConflict(error))) {
      throw error;
    }
    await wf.get(opts.id);
    return { id: opts.id };
  }
};

/**
 * Start many instances. Prefers Cloudflare `createBatch` (skips existing ids).
 * Falls back to sequential {@link createWorkflowInstance}.
 */
export const createWorkflowInstanceBatch =
  async function createWorkflowInstanceBatch(
    wf: {
      create: (opts?: WorkflowCreateOptions) => Promise<{ id: string }>;
      createBatch?: (
        batch: WorkflowCreateOptions[]
      ) => Promise<{ id: string }[]>;
      get: (id: string) => Promise<{ id?: string } | object>;
    },
    batch: WorkflowCreateOptions[]
  ): Promise<void> {
    if (batch.length === 0) {
      return;
    }
    if (typeof wf.createBatch === "function") {
      try {
        await wf.createBatch(batch);
        return;
      } catch (error) {
        // Some hosts throw on duplicate ids instead of skipping — fall through
        // to idempotent per-id create/get.
        if (!isWorkflowIdConflict(error) && batch.length > 1) {
          throw error;
        }
      }
    }
    for (const opts of batch) {
      // Sequential creates keep message order when max_batch_size > 1.
      // oxlint-disable-next-line eslint/no-await-in-loop -- durable starts should not race the same batch
      await createWorkflowInstance(wf, opts);
    }
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

/**
 * Define a durable Cloudflare Workers Workflow in a `*.server.ts` file. On the
 * worker, oxide emits a `WorkflowEntrypoint` class and wrangler binding. Call
 * `start` / `status` / `send` like actions (RPC stubs on the client).
 *
 * ```ts
 * // src/invoice.server.ts
 * export const invoice = workflow({
 *   name: "invoice",
 *   payload: Schema.Struct({ orderId: Schema.String }),
 *   run: async ({ payload }, step) => {
 *     await step.do("charge", () => charge(payload.orderId));
 *   },
 * });
 *
 * const { id } = await invoice.start({ orderId: "…" });
 * ```
 */
export const workflow = function workflow<P, R = unknown>(
  def: WorkflowDefinition<P, R>
): WorkflowHandle<P, R> {
  const name = def.name.trim();
  if (!name) {
    throw new Error("oxidejs: workflow({ name }) is required");
  }
  const binding = def.binding ?? toWorkflowBinding(name);
  const className = def.className ?? toWorkflowClassName(name);
  const meta: WorkflowMeta<P, R> = {
    binding,
    className,
    name,
    run: def.run,
  };
  if (def.payload) {
    meta.payload = def.payload;
  }

  const start = async (
    ...allArgs: [P] | [P, CallOptions]
  ): Promise<WorkflowStartResult> => {
    const { args, options } = peelTrailingOptions(allArgs);
    // SAFETY: start always receives params as first arg after peel.
    const raw = args[0] as P;
    const decoded = decodePayload(def.payload, raw);
    const wf = requireBinding(binding);
    const id =
      options?.idempotencyKey ?? useIdempotencyKey() ?? crypto.randomUUID();
    const instance = await createWorkflowInstance(wf, { id, params: decoded });
    return { id: instance.id };
  };

  const status = async (
    ...allArgs: [string] | [string, CallOptions]
  ): Promise<WorkflowInstanceStatus> => {
    const { args } = peelTrailingOptions(allArgs);
    // SAFETY: status always receives id as first arg after peel.
    const id = args[0] as string;
    try {
      const instance = await requireBinding(binding).get(id);
      return normalizeWorkflowStatus(await instance.status());
    } catch (error) {
      // CF `Workflow.get` throws when the instance does not exist yet (e.g. queue
      // consumer has not created it) — surface as a status, not a Defect.
      if (isWorkflowInstanceMissing(error)) {
        return { status: "not_found" };
      }
      // Platform / host errors become status.error so Rpc scrub does not hide
      // the message behind JSON-RPC "Internal error".
      return {
        error: { message: workflowErrorText(error) || "status failed" },
        status: "unknown",
      };
    }
  };

  const send = async (
    ...allArgs:
      | [string, WorkflowSendEvent]
      | [string, WorkflowSendEvent, CallOptions]
  ): Promise<void> => {
    const { args } = peelTrailingOptions(allArgs);
    // SAFETY: send always receives id + event after peel.
    const id = args[0] as string;
    // SAFETY: second arg is WorkflowSendEvent from the call signature.
    const event = args[1] as WorkflowSendEvent;
    const instance = await requireBinding(binding).get(id);
    await instance.sendEvent(event);
  };

  const handle = { send, start, status };
  // SAFETY: install oxide-owned meta on the callable handle object.
  (handle as WorkflowHandle<P, R>)[WORKFLOW_META] = meta;
  // SAFETY: handle methods match WorkflowHandle; meta stamped above.
  return handle as WorkflowHandle<P, R>;
};
