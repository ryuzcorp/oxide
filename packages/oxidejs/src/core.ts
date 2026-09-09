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
  OxidejsWranglerOptions,
  ResolvedOptions,
} from "./types";
import { scanWorkflowFiles, workflowWranglerEntries } from "./workflow-build";

export const WORKER_WRANGLER_KEYS = [
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "account_id",
  "workers_dev",
  "routes",
  "d1_databases",
  "durable_objects",
  "migrations",
  "assets",
  "kv_namespaces",
  "r2_buckets",
  "services",
  "vars",
  "workflows",
  "queues",
  "triggers",
] as const;

const USER_FORBIDDEN_KEYS = ["main", "assets"] as const;

export interface EmitState {
  emitted: boolean;
}

export const createEmitState = function createEmitState(): EmitState {
  return { emitted: false };
};

export const validateWranglerOptions = function validateWranglerOptions(
  wrangler: OxidejsWranglerOptions
): void {
  const allowed: readonly string[] = WORKER_WRANGLER_KEYS;
  const invalid = Object.keys(wrangler).filter((key) => !allowed.includes(key));
  if (invalid.length) {
    throw new Error(
      `oxidejs: these wrangler keys are not supported by the worker preset: ${invalid.join(", ")}`
    );
  }

  const forbidden = USER_FORBIDDEN_KEYS.filter((key) => key in wrangler);
  if (forbidden.length) {
    throw new Error(
      `oxidejs: wrangler keys ${forbidden.join(", ")} are computed by the plugin and cannot be user-supplied`
    );
  }
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

const requireWranglerFields = function requireWranglerFields(
  wrangler: OxidejsWranglerOptions | undefined
): OxidejsWranglerOptions {
  if (!wrangler?.name || !wrangler.compatibility_date) {
    throw new Error(
      "oxidejs: wrangler.name and wrangler.compatibility_date are required when emitConfig is true"
    );
  }
  return wrangler;
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

const envInput = function envInput(
  env: HtmlEnvironment | undefined
): HtmlInput | undefined {
  if (env === undefined) {
    return;
  }
  return (
    env.build?.rolldownOptions?.input ||
    env.build?.rollupOptions?.input ||
    env.build?.input ||
    env.input
  );
};

/** Vite client input: rolldown/rollup `input`, else `path.resolve(root, "index.html")`. */
const hasHtmlEntry = function hasHtmlEntry(
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
  path: string;
  sameOrigin: boolean;
  transport: OxidejsActionTransport;
}

const resolveActions = function resolveActions(
  raw: OxidejsActions | undefined
): ResolvedActions {
  if (raw === undefined) {
    return { path: ACTION_PATH, sameOrigin: true, transport: "http" };
  }
  if (raw === "http" || raw === "ws") {
    return { path: ACTION_PATH, sameOrigin: true, transport: raw };
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
  return { path: actionsPath, sameOrigin: raw.sameOrigin ?? true, transport };
};

const resolvePreset = function resolvePreset(
  raw: OxidejsOptions | undefined
): OxidejsPreset {
  const preset = raw?.preset ?? "fetch";
  if (preset !== "fetch" && preset !== "worker") {
    throw new Error(`oxidejs: unknown preset "${String(preset)}"`);
  }
  return preset;
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

const resolveWrangler = function resolveWrangler(
  raw: OxidejsOptions | undefined,
  emitConfig: boolean
): OxidejsWranglerOptions | undefined {
  if (raw?.wrangler) {
    validateWranglerOptions(raw.wrangler);
  }
  return emitConfig ? requireWranglerFields(raw?.wrangler) : raw?.wrangler;
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
  const preset = resolvePreset(raw);
  const {
    transport: actions,
    path: actionPath,
    sameOrigin: actionSameOrigin,
  } = resolveActions(raw?.actions);
  const emitConfig = raw?.emitConfig ?? preset === "worker";
  const {
    clientDir,
    hasWorkerEntry,
    outDir,
    rootAbs,
    workerEntry,
    workerEntryAbs,
  } = resolvePaths(raw, root);
  const hasClient = hasHtmlEntry(rootAbs, config);
  const hasPublic = fs.existsSync(path.join(rootAbs, "public"));
  assertClientDir(outDir, clientDir, hasClient, hasPublic);
  const wrangler = resolveWrangler(raw, emitConfig);

  return {
    actionHeaders: raw?.actionHeaders,
    actionPath,
    actionSameOrigin,
    actions,
    bodyLimit: raw?.bodyLimit ?? 1_048_576,
    clientDir,
    emitConfig,
    env: raw?.env,
    hasClient,
    hasPublic,
    hasWorkerEntry,
    imports: raw?.imports ?? [],
    middleware: resolveMiddleware(raw?.middleware ?? [], rootAbs),
    notFound: raw?.notFound,
    outDir,
    preset,
    root: rootAbs,
    workerEntry,
    workerEntryAbs,
    wrangler,
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

interface EmittedWranglerConfig {
  account_id?: string;
  assets?: {
    binding: string;
    directory: string;
    not_found_handling?: "single-page-application";
  };
  compatibility_date: string;
  compatibility_flags?: string[];
  d1_databases?: OxidejsWranglerOptions["d1_databases"];
  durable_objects?: OxidejsWranglerOptions["durable_objects"];
  kv_namespaces?: OxidejsWranglerOptions["kv_namespaces"];
  main: string;
  migrations?: OxidejsWranglerOptions["migrations"];
  name: string;
  r2_buckets?: OxidejsWranglerOptions["r2_buckets"];
  routes?: OxidejsWranglerOptions["routes"];
  services?: OxidejsWranglerOptions["services"];
  vars?: OxidejsWranglerOptions["vars"];
  workers_dev?: boolean;
  workflows?: OxidejsWranglerOptions["workflows"];
  queues?: OxidejsWranglerOptions["queues"];
  triggers?: OxidejsWranglerOptions["triggers"];
}

const mergeWranglerWorkflows = function mergeWranglerWorkflows(
  manual: NonNullable<OxidejsWranglerOptions["workflows"]>,
  scanned: NonNullable<OxidejsWranglerOptions["workflows"]>
) {
  if (scanned.length === 0 && manual.length === 0) {
    return;
  }
  const byBinding = new Map<string, (typeof scanned)[number]>();
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
  manual: NonNullable<OxidejsWranglerOptions["queues"]>,
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
  manual: NonNullable<OxidejsWranglerOptions["triggers"]>,
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
  config: EmittedWranglerConfig,
  wrangler: NonNullable<ResolvedOptions["wrangler"]>,
  root: string
): void {
  const scannedWorkflows = scanWorkflowFiles(root);
  const workflows = mergeWranglerWorkflows(
    wrangler.workflows ?? [],
    workflowWranglerEntries(scannedWorkflows)
  );
  if (workflows) {
    config.workflows = workflows;
  }
  const scannedQueues = scanQueueFiles(root);
  resolveQueueWorkflowRefs(scannedQueues, scannedWorkflows);
  const queues = mergeWranglerQueues(
    wrangler.queues ?? {},
    queueWranglerEntries(scannedQueues)
  );
  if (queues) {
    config.queues = queues;
  }
  const scannedSchedules = scanScheduleFiles(root);
  resolveScheduleRefs(scannedSchedules, scannedWorkflows, scannedQueues);
  const triggers = mergeWranglerTriggers(
    wrangler.triggers ?? {},
    scheduleWranglerCrons(scannedSchedules)
  );
  if (triggers) {
    config.triggers = triggers;
  }
};

export const tryEmitWranglerConfig = function tryEmitWranglerConfig(
  opts: ResolvedOptions,
  state: EmitState
): void {
  if (state.emitted || opts.emitConfig === false) {
    return;
  }

  const wrangler = requireWranglerFields(opts.wrangler);
  const serverFile = path.join(opts.outDir, "server.js");
  const clientDirPath = path.join(opts.outDir, opts.clientDir);

  if (!fs.existsSync(serverFile)) {
    return;
  }
  if (opts.hasClient && !fs.existsSync(clientDirPath)) {
    return;
  }

  assertContained(opts.outDir, serverFile, "main");
  if (opts.hasClient) {
    assertContained(opts.outDir, clientDirPath, "assets.directory");
  }

  const flags = wrangler.compatibility_flags
    ? [...new Set(wrangler.compatibility_flags)]
    : [];
  const config: EmittedWranglerConfig = {
    compatibility_date: wrangler.compatibility_date,
    main: "./server.js",
    name: wrangler.name,
  };
  if (flags.length > 0) {
    config.compatibility_flags = flags;
  }
  // Cloudflare-only deploy keys. Omit them for celld — unknown top-level keys
  // fail `celld deploy`. Set these when you deploy with wrangler to Cloudflare.
  if (wrangler.account_id) {
    config.account_id = wrangler.account_id;
  }
  if (wrangler.workers_dev !== undefined) {
    config.workers_dev = wrangler.workers_dev;
  }
  if (wrangler.routes) {
    config.routes = wrangler.routes;
  }
  if (wrangler.d1_databases) {
    config.d1_databases = wrangler.d1_databases;
  }
  if (wrangler.durable_objects) {
    config.durable_objects = wrangler.durable_objects;
  }
  if (wrangler.migrations) {
    config.migrations = wrangler.migrations;
  }
  if (wrangler.kv_namespaces) {
    config.kv_namespaces = wrangler.kv_namespaces;
  }
  if (wrangler.r2_buckets) {
    config.r2_buckets = wrangler.r2_buckets;
  }
  if (wrangler.services) {
    config.services = wrangler.services;
  }
  if (wrangler.vars) {
    config.vars = wrangler.vars;
  }
  applyScannedBindings(config, wrangler, opts.root);
  if (opts.hasClient) {
    config.assets = {
      binding: "ASSETS",
      directory: `./${opts.clientDir}`,
      not_found_handling: "single-page-application",
    };
  }

  fs.writeFileSync(
    path.join(opts.outDir, "wrangler.jsonc"),
    `${JSON.stringify(config, null, 2)}\n`
  );
  state.emitted = true;
};
