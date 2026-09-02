import fs from "node:fs";
import path from "node:path";
import type {
  OxidejsActions,
  OxidejsActionTransport,
  OxidejsOptions,
  OxidejsPreset,
  OxidejsWranglerOptions,
  ResolvedOptions,
} from "./types";
import { ACTION_PATH } from "./actions";

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

export function createEmitState(): EmitState {
  return { emitted: false };
}

export function validateWranglerOptions(wrangler: Record<string, unknown>): void {
  const allowed: readonly string[] = CELLD_ALLOWED_KEYS;
  const invalid = Object.keys(wrangler).filter((key) => !allowed.includes(key));
  if (invalid.length) {
    throw new Error(
      `oxidejs: these wrangler keys are not supported by celld deploy: ${invalid.join(", ")}`,
    );
  }

  const forbidden = USER_FORBIDDEN_KEYS.filter((key) => key in wrangler);
  if (forbidden.length) {
    throw new Error(
      `oxidejs: wrangler keys ${forbidden.join(", ")} are computed by the plugin and cannot be user-supplied`,
    );
  }
}

export function assertContained(outDirAbs: string, childAbs: string, label: string): void {
  const outDir = path.resolve(outDirAbs);
  const child = path.resolve(childAbs);
  const relative = path.relative(outDir, child);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`oxidejs: ${label} must resolve inside outDir (got ${relative || "."})`);
  }
}

function requireWranglerFields(
  wrangler: OxidejsWranglerOptions | undefined,
): OxidejsWranglerOptions {
  if (!wrangler?.name || !wrangler.compatibility_date) {
    throw new Error(
      "oxidejs: wrangler.name and wrangler.compatibility_date are required when emitConfig is true",
    );
  }
  return wrangler;
}

type HtmlInput = string | string[] | Record<string, string>;

interface HtmlEntryConfig {
  build?: {
    rolldownOptions?: { input?: HtmlInput };
    rollupOptions?: { input?: HtmlInput };
  };
  environments?: Record<string, unknown>;
}

function flattenInput(input: HtmlInput | undefined): string[] {
  if (!input) return [];
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) return input;
  return Object.values(input);
}

function envInput(env: unknown): HtmlInput | undefined {
  if (!env || typeof env !== "object") return;
  const rec = env as {
    input?: HtmlInput;
    build?: {
      input?: HtmlInput;
      rolldownOptions?: { input?: HtmlInput };
      rollupOptions?: { input?: HtmlInput };
    };
  };
  return (
    rec.build?.rolldownOptions?.input ||
    rec.build?.rollupOptions?.input ||
    rec.build?.input ||
    rec.input
  );
}

/** Vite client input: rolldown/rollup `input`, else `path.resolve(root, "index.html")`. */
function hasHtmlEntry(root: string, config?: unknown): boolean {
  const cfg = config as HtmlEntryConfig | undefined;
  const explicit =
    envInput(cfg?.environments?.["client"]) ||
    envInput(cfg?.environments?.["web"]) ||
    cfg?.build?.rolldownOptions?.input ||
    cfg?.build?.rollupOptions?.input;
  const entries = flattenInput(explicit || path.resolve(root, "index.html"));
  return entries.some((entry) => {
    const file = path.resolve(root, entry);
    return file.endsWith(".html") && fs.existsSync(file);
  });
}

function resolveActions(raw: OxidejsActions | undefined): {
  transport: OxidejsActionTransport;
  path: string;
  sameOrigin: boolean;
} {
  if (raw === undefined || typeof raw === "string") {
    const transport = raw ?? "http";
    if (transport !== "http" && transport !== "ws") {
      throw new Error(`oxidejs: unknown actions transport "${String(transport)}"`);
    }
    return { transport, path: ACTION_PATH, sameOrigin: true };
  }
  const transport = raw.transport ?? "http";
  if (transport !== "http" && transport !== "ws") {
    throw new Error(`oxidejs: unknown actions transport "${String(transport)}"`);
  }
  const path = raw.path ?? ACTION_PATH;
  if (!path.startsWith("/") || path.includes("?")) {
    throw new Error(
      `oxidejs: actions.path must start with "/" and contain no query string (got "${path}")`,
    );
  }
  return { transport, path, sameOrigin: raw.sameOrigin ?? true };
}

export function resolveOptions(
  raw: OxidejsOptions | undefined,
  root: string,
  config?: unknown,
): ResolvedOptions {
  const preset: OxidejsPreset = raw?.preset ?? "fetch";
  if (preset !== "fetch" && preset !== "celld") {
    throw new Error(`oxidejs: unknown preset "${String(preset)}"`);
  }
  const {
    transport: actions,
    path: actionPath,
    sameOrigin: actionSameOrigin,
  } = resolveActions(raw?.actions);
  if (actions === "ws" && preset === "celld") {
    throw new Error('oxidejs: actions: "ws" is not supported with preset: "celld"');
  }
  const workerEntry = raw?.workerEntry ?? "src/server.ts";
  const outDirInput = raw?.outDir ?? "dist";
  const clientDir = raw?.clientDir ?? "client";
  const emitConfig = raw?.emitConfig ?? preset === "celld";

  const rootAbs = path.resolve(root);
  const outDir = path.resolve(rootAbs, outDirInput);
  const workerEntryAbs = path.resolve(rootAbs, workerEntry);
  const hasClient = hasHtmlEntry(rootAbs, config);
  const hasPublic = fs.existsSync(path.join(rootAbs, "public"));

  if (hasClient || hasPublic) assertContained(outDir, path.resolve(outDir, clientDir), "clientDir");

  if (raw?.wrangler) {
    // SAFETY: validateWranglerOptions only reads Object.keys; OxidejsWranglerOptions is a plain object.
    validateWranglerOptions(raw.wrangler as unknown as Record<string, unknown>);
  }

  const wrangler = emitConfig ? requireWranglerFields(raw?.wrangler) : raw?.wrangler;

  return {
    root: rootAbs,
    preset,
    workerEntry,
    workerEntryAbs,
    outDir,
    clientDir,
    wrangler,
    emitConfig,
    hasClient,
    hasPublic,
    actions,
    actionPath,
    actionSameOrigin,
    actionHeaders: raw?.actionHeaders,
    middleware: raw?.middleware ?? [],
    imports: raw?.imports ?? [],
    bodyLimit: raw?.bodyLimit ?? 1048576,
    notFound: raw?.notFound,
    env: raw?.env,
  };
}

export function copyPublicDir(opts: ResolvedOptions): void {
  if (opts.preset !== "fetch") return;
  const src = path.join(opts.root, "public");
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, path.join(opts.outDir, opts.clientDir), { recursive: true, force: true });
}

export function tryEmitWranglerConfig(opts: ResolvedOptions, state: EmitState): void {
  if (state.emitted || opts.emitConfig === false) return;

  const wrangler = requireWranglerFields(opts.wrangler);
  const serverFile = path.join(opts.outDir, "server.js");
  const clientDirPath = path.join(opts.outDir, opts.clientDir);

  if (!fs.existsSync(serverFile)) return;
  if (opts.hasClient && !fs.existsSync(clientDirPath)) return;

  assertContained(opts.outDir, serverFile, "main");
  if (opts.hasClient) assertContained(opts.outDir, clientDirPath, "assets.directory");

  const config = {
    name: wrangler.name,
    main: "./server.js",
    compatibility_date: wrangler.compatibility_date,
    compatibility_flags: [...new Set([...(wrangler.compatibility_flags ?? []), "nodejs_compat"])],
    ...(wrangler.durable_objects ? { durable_objects: wrangler.durable_objects } : {}),
    ...(wrangler.migrations ? { migrations: wrangler.migrations } : {}),
    ...(wrangler.services ? { services: wrangler.services } : {}),
    ...(wrangler.vars ? { vars: wrangler.vars } : {}),
    ...(opts.hasClient ? { assets: { directory: `./${opts.clientDir}`, binding: "ASSETS" } } : {}),
  };

  fs.writeFileSync(
    path.join(opts.outDir, "wrangler.jsonc"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  state.emitted = true;
}
