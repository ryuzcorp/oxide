import fs from "node:fs";
import path from "node:path";

import { ACTION_PATH } from "./actions";
import type {
  OxidejsActions,
  OxidejsActionTransport,
  OxidejsOptions,
  OxidejsPreset,
  OxidejsWranglerOptions,
  ResolvedOptions,
} from "./types";

export const CELLD_ALLOWED_KEYS = [
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "durable_objects",
  "migrations",
  "assets",
  "services",
  "vars",
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
  const allowed: readonly string[] = CELLD_ALLOWED_KEYS;
  const invalid = Object.keys(wrangler).filter((key) => !allowed.includes(key));
  if (invalid.length) {
    throw new Error(
      `oxidejs: these wrangler keys are not supported by celld deploy: ${invalid.join(", ")}`
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
  const preset: OxidejsPreset = raw?.preset ?? "fetch";
  if (preset !== "fetch" && preset !== "celld") {
    throw new Error(`oxidejs: unknown preset "${String(preset)}"`);
  }
  return preset;
};

interface ResolvedPaths {
  clientDir: string;
  outDir: string;
  rootAbs: string;
  workerEntry: string;
  workerEntryAbs: string;
}

const resolvePaths = function resolvePaths(
  raw: OxidejsOptions | undefined,
  root: string
): ResolvedPaths {
  const workerEntry = raw?.workerEntry ?? "src/server.ts";
  const outDirInput = raw?.outDir ?? "dist";
  const clientDir = raw?.clientDir ?? "client";
  const rootAbs = path.resolve(root);
  return {
    clientDir,
    outDir: path.resolve(rootAbs, outDirInput),
    rootAbs,
    workerEntry,
    workerEntryAbs: path.resolve(rootAbs, workerEntry),
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
  if (actions === "ws" && preset === "celld") {
    throw new Error(
      'oxidejs: actions: "ws" is not supported with preset: "celld"'
    );
  }
  const emitConfig = raw?.emitConfig ?? preset === "celld";
  const { clientDir, outDir, rootAbs, workerEntry, workerEntryAbs } =
    resolvePaths(raw, root);
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
    imports: raw?.imports ?? [],
    middleware: raw?.middleware ?? [],
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
  assets?: { binding: string; directory: string };
  compatibility_date: string;
  compatibility_flags: string[];
  durable_objects?: OxidejsWranglerOptions["durable_objects"];
  main: string;
  migrations?: OxidejsWranglerOptions["migrations"];
  name: string;
  services?: OxidejsWranglerOptions["services"];
  vars?: OxidejsWranglerOptions["vars"];
}

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

  const config: EmittedWranglerConfig = {
    compatibility_date: wrangler.compatibility_date,
    compatibility_flags: [
      ...new Set([...(wrangler.compatibility_flags ?? []), "nodejs_compat"]),
    ],
    main: "./server.js",
    name: wrangler.name,
  };
  if (wrangler.durable_objects) {
    config.durable_objects = wrangler.durable_objects;
  }
  if (wrangler.migrations) {
    config.migrations = wrangler.migrations;
  }
  if (wrangler.services) {
    config.services = wrangler.services;
  }
  if (wrangler.vars) {
    config.vars = wrangler.vars;
  }
  if (opts.hasClient) {
    config.assets = { binding: "ASSETS", directory: `./${opts.clientDir}` };
  }

  fs.writeFileSync(
    path.join(opts.outDir, "wrangler.jsonc"),
    `${JSON.stringify(config, null, 2)}\n`
  );
  state.emitted = true;
};
