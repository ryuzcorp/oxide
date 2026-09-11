import fs from "node:fs";
import path from "node:path";

import { ACTION_PATH } from "./actions";
import {
  queueWranglerEntries,
  resolveQueueWorkflowRefs,
  scanQueueFiles,
} from "./queue-build";
import {
  resolveScheduleRefs,
  scanScheduleFiles,
  scheduleWranglerCrons,
} from "./schedule-build";
import type {
  OxidejsActions,
  OxidejsActionTransport,
  OxidejsOptions,
  OxidejsPreset,
  ResolvedOptions,
} from "./types";
import { scanWorkflowFiles, workflowWranglerEntries } from "./workflow-build";

const WRANGLER_CONFIG_NAMES = [
  "wrangler.jsonc",
  "wrangler.toml",
  "wrangler.json",
] as const;

/** True when a root wrangler config file is present. */
export const hasWranglerConfig = function hasWranglerConfig(
  root: string
): boolean {
  return WRANGLER_CONFIG_NAMES.some((name) =>
    fs.existsSync(path.join(root, name))
  );
};

const resolvePreset = function resolvePreset(
  raw: OxidejsOptions | undefined,
  rootAbs: string
): OxidejsPreset {
  const preset = raw?.preset;
  if (preset === undefined) {
    return hasWranglerConfig(rootAbs) ? "worker" : "fetch";
  }
  if (preset !== "fetch" && preset !== "worker") {
    throw new Error(`oxidejs: unknown preset "${String(preset)}"`);
  }
  return preset;
};

export const assertContained = function assertContained(
  outDirAbs: string,
  childAbs: string,
  label: string
): void {
  const outDir = path.resolve(outDirAbs);
  const child = path.resolve(childAbs);
  const relative = path.relative(outDir, child);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `oxidejs: ${label} must resolve inside outDir (got ${relative || "."})`
    );
  }
};

type HtmlInput = string | string[] | { [key: string]: string };

interface HtmlEnvironment {
  input?: HtmlInput;
  build?: {
    input?: HtmlInput;
    rolldownOptions?: { input?: HtmlInput };
    rollupOptions?: { input?: HtmlInput };
  };
}

interface HtmlEntryConfig {
  build?: {
    rolldownOptions?: { input?: HtmlInput };
    rollupOptions?: { input?: HtmlInput };
  };
  environments?: { [key: string]: HtmlEnvironment | undefined };
}

const flattenInput = function flattenInput(
  input: HtmlInput | undefined
): string[] {
  if (input === undefined) {
    return [];
  }
  if (Array.isArray(input)) {
    return input;
  }
  if (Object.prototype.toString.call(input) === "[object Object]") {
    // SAFETY: non-array object HtmlInput is a string record.
    return Object.values(input as { [key: string]: string });
  }
  // SAFETY: remaining HtmlInput branch after array/object checks is string.
  return [input as string];
};

const envInput = function envInput(env: HtmlEnvironment | undefined) {
  return (
    env?.input ||
    env?.build?.input ||
    env?.build?.rolldownOptions?.input ||
    env?.build?.rollupOptions?.input
  );
};

export const hasHtmlEntry = function hasHtmlEntry(
  root: string,
  config?: HtmlEntryConfig
): boolean {
  const explicit =
    envInput(config?.environments?.["client"]) ||
    envInput(config?.environments?.["web"]) ||
    config?.build?.rolldownOptions?.input ||
    config?.build?.rollupOptions?.input;
  const entries = flattenInput(explicit || path.resolve(root, "index.html"));
  return entries.some((entry) => {
    const file = path.resolve(root, entry);
    return file.endsWith(".html") && fs.existsSync(file);
  });
};

interface ResolvedActions {
  openrpc: boolean;
  path: string;
  sameOrigin: boolean;
  transport: OxidejsActionTransport;
}

const resolveActions = function resolveActions(
  raw: OxidejsActions | undefined
): ResolvedActions {
  if (raw === undefined) {
    return {
      openrpc: false,
      path: ACTION_PATH,
      sameOrigin: true,
      transport: "http",
    };
  }
  if (raw === "http" || raw === "ws") {
    return {
      openrpc: false,
      path: ACTION_PATH,
      sameOrigin: true,
      transport: raw,
    };
  }
  if (Object.prototype.toString.call(raw) !== "[object Object]") {
    throw new Error(`oxidejs: unknown actions transport "${String(raw)}"`);
  }
  const transport = raw.transport ?? "http";
  if (transport !== "http" && transport !== "ws") {
    throw new Error(
      `oxidejs: unknown actions transport "${String(transport)}"`
    );
  }
  const actionsPath = raw.path ?? ACTION_PATH;
  if (!actionsPath.startsWith("/") || actionsPath.includes("?")) {
    throw new Error(
      `oxidejs: actions.path must start with "/" and contain no query string (got "${actionsPath}")`
    );
  }
  return {
    openrpc: raw.openrpc === true,
    path: actionsPath,
    sameOrigin: raw.sameOrigin ?? true,
    transport,
  };
};

interface ResolvedPaths {
  clientDir: string;
  hasWorkerEntry: boolean;
  outDir: string;
  rootAbs: string;
  workerEntry: string;
  workerEntryAbs: string;
}

const resolvePaths = function resolvePaths(
  raw: OxidejsOptions | undefined,
  root: string
): ResolvedPaths {
  const workerEntryExplicit = raw?.workerEntry !== undefined;
  const workerEntry = raw?.workerEntry ?? "src/server.ts";
  const outDirInput = raw?.outDir ?? "dist";
  const clientDir = raw?.clientDir ?? "client";
  const rootAbs = path.resolve(root);
  const workerEntryAbs = path.resolve(rootAbs, workerEntry);
  const hasWorkerEntry = fs.existsSync(workerEntryAbs);
  if (workerEntryExplicit && !hasWorkerEntry) {
    throw new Error(
      `oxidejs: workerEntry "${workerEntry}" not found at ${workerEntryAbs}`
    );
  }
  return {
    clientDir,
    hasWorkerEntry,
    outDir: path.resolve(rootAbs, outDirInput),
    rootAbs,
    workerEntry,
    workerEntryAbs,
  };
};

const assertClientDir = function assertClientDir(
  outDir: string,
  clientDir: string,
  hasClient: boolean,
  hasPublic: boolean
): void {
  if (hasClient || hasPublic) {
    assertContained(outDir, path.resolve(outDir, clientDir), "clientDir");
  }
};

const resolveMiddlewareId = function resolveMiddlewareId(
  id: string,
  rootAbs: string
) {
  if (id.startsWith(".") || path.isAbsolute(id)) {
    return path.resolve(rootAbs, id);
  }
  return id;
};

const resolveMiddleware = function resolveMiddleware(
  middleware: NonNullable<OxidejsOptions["middleware"]>,
  rootAbs: string
) {
  return middleware.map((entry) => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- middleware entry is string | { module }
    if (typeof entry === "string") {
      return resolveMiddlewareId(entry, rootAbs);
    }
    return {
      ...entry,
      module: resolveMiddlewareId(entry.module, rootAbs),
    };
  });
};

export const resolveOptions = function resolveOptions(
  raw: OxidejsOptions | undefined,
  root: string,
  config?: HtmlEntryConfig
): ResolvedOptions {
  const {
    clientDir,
    hasWorkerEntry,
    outDir,
    rootAbs,
    workerEntry,
    workerEntryAbs,
  } = resolvePaths(raw, root);
  const preset = resolvePreset(raw, rootAbs);
  const {
    transport: actions,
    path: actionPath,
    sameOrigin: actionSameOrigin,
    openrpc: actionOpenRpc,
  } = resolveActions(raw?.actions);
  const hasClient = hasHtmlEntry(rootAbs, config);
  const hasPublic = fs.existsSync(path.join(rootAbs, "public"));
  assertClientDir(outDir, clientDir, hasClient, hasPublic);

  return {
    actionHeaders: raw?.actionHeaders,
    actionOpenRpc,
    actionPath,
    actionSameOrigin,
    actions,
    bodyLimit: raw?.bodyLimit ?? 1_048_576,
    clientDir,
    env: raw?.env,
    hasClient,
    hasPublic,
    hasWorkerEntry,
    imports: raw?.imports ?? [],
    middleware: resolveMiddleware(raw?.middleware ?? [], rootAbs),
    notFound: raw?.notFound,
    outDir,
    plugins: raw?.plugins ?? [],
    preset,
    root: rootAbs,
    workerEntry,
    workerEntryAbs,
  };
};

export const copyPublicDir = function copyPublicDir(
  opts: ResolvedOptions
): void {
  if (opts.preset !== "fetch") {
    return;
  }
  const src = path.join(opts.root, "public");
  if (!fs.existsSync(src)) {
    return;
  }
  fs.cpSync(src, path.join(opts.outDir, opts.clientDir), {
    force: true,
    recursive: true,
  });
};

export interface DurableWorkflowBinding {
  binding: string;
  class_name: string;
  name: string;
  script_name?: string;
}

export interface DurableQueueConfig {
  consumers?: {
    dead_letter_queue?: string;
    max_batch_size?: number;
    max_batch_timeout?: number;
    max_retries?: number;
    queue: string;
  }[];
  producers?: {
    binding: string;
    /** Present on oxide-scanned producers; Cloudflare's config type allows omit. */
    queue?: string;
  }[];
}

export interface DurableTriggersConfig {
  crons?: string[];
}

/** Mutable wrangler bag that receives scanned workflow / queue / schedule bindings. */
export interface DurableWranglerConfig {
  workflows?: DurableWorkflowBinding[];
  queues?: DurableQueueConfig;
  triggers?: DurableTriggersConfig;
}

const mergeWranglerWorkflows = function mergeWranglerWorkflows(
  manual: DurableWorkflowBinding[],
  scanned: DurableWorkflowBinding[]
) {
  if (scanned.length === 0 && manual.length === 0) {
    return;
  }
  const byBinding = new Map<string, DurableWorkflowBinding>();
  for (const entry of [...manual, ...scanned]) {
    const prior = byBinding.get(entry.binding);
    if (
      prior &&
      (prior.name !== entry.name || prior.class_name !== entry.class_name)
    ) {
      throw new Error(
        `oxidejs: duplicate wrangler workflow binding "${entry.binding}"`
      );
    }
    byBinding.set(entry.binding, entry);
  }
  return [...byBinding.values()];
};

const mergeWranglerQueues = function mergeWranglerQueues(
  manual: DurableQueueConfig,
  scanned: ReturnType<typeof queueWranglerEntries>
) {
  const producers = [...(manual.producers ?? []), ...scanned.producers];
  const consumers = [...(manual.consumers ?? []), ...scanned.consumers];
  if (producers.length === 0 && consumers.length === 0) {
    return;
  }
  const byProducerBinding = new Map<string, (typeof producers)[number]>();
  for (const entry of producers) {
    const prior = byProducerBinding.get(entry.binding);
    if (prior && prior.queue !== entry.queue) {
      throw new Error(
        `oxidejs: duplicate wrangler queue producer binding "${entry.binding}"`
      );
    }
    byProducerBinding.set(entry.binding, entry);
  }
  const byConsumerQueue = new Map<string, (typeof consumers)[number]>();
  for (const entry of consumers) {
    const prior = byConsumerQueue.get(entry.queue);
    if (prior) {
      throw new Error(
        `oxidejs: duplicate wrangler queue consumer for "${entry.queue}"`
      );
    }
    byConsumerQueue.set(entry.queue, entry);
  }
  return {
    consumers: [...byConsumerQueue.values()],
    producers: [...byProducerBinding.values()],
  };
};

const mergeWranglerTriggers = function mergeWranglerTriggers(
  manual: DurableTriggersConfig,
  scannedCrons: string[]
) {
  const crons = [...new Set([...(manual.crons ?? []), ...scannedCrons])];
  // SAFETY: Bun provides Array.prototype.toSorted; package tsconfig targets ES2022 without its typings.
  const sorted = (crons as string[] & { toSorted: () => string[] }).toSorted();
  if (sorted.length === 0) {
    return;
  }
  return { crons: sorted };
};

const applyScannedBindings = function applyScannedBindings(
  config: DurableWranglerConfig,
  root: string,
  manual: DurableWranglerConfig = {}
): void {
  const scannedWorkflows = scanWorkflowFiles(root);
  const workflows = mergeWranglerWorkflows(
    manual.workflows ?? [],
    workflowWranglerEntries(scannedWorkflows)
  );
  if (workflows) {
    config.workflows = workflows;
  }
  const scannedQueues = scanQueueFiles(root);
  resolveQueueWorkflowRefs(scannedQueues, scannedWorkflows);
  const queues = mergeWranglerQueues(
    manual.queues ?? {},
    queueWranglerEntries(scannedQueues)
  );
  if (queues) {
    config.queues = queues;
  }
  const scannedSchedules = scanScheduleFiles(root);
  resolveScheduleRefs(scannedSchedules, scannedWorkflows, scannedQueues);
  const triggers = mergeWranglerTriggers(
    manual.triggers ?? {},
    scheduleWranglerCrons(scannedSchedules)
  );
  if (triggers) {
    config.triggers = triggers;
  }
};

/**
 * Merge scanned `workflow()` / `queue()` / `schedule()` bindings into a wrangler
 * config object (mutates in place). Use with `@cloudflare/vite-plugin`'s `config`
 * customizer — mutate `config` and return nothing so Cloudflare's `defu` merge
 * does not concatenate the same arrays twice.
 */
export const mergeDurableBindings = function mergeDurableBindings(
  config: DurableWranglerConfig,
  root: string = process.cwd()
): void {
  applyScannedBindings(config, root);
};
