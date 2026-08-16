import fs from "node:fs";
import path from "node:path";
import type {
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

export function resolveOptions(raw: OxidejsOptions | undefined, root: string): ResolvedOptions {
  const preset: OxidejsPreset = raw?.preset ?? "fetch";
  if (preset !== "fetch" && preset !== "celld") {
    throw new Error(`oxidejs: unknown preset "${String(preset)}"`);
  }
  const workerEntry = raw?.workerEntry ?? "src/server.ts";
  const outDirInput = raw?.outDir ?? "dist";
  const clientDir = raw?.clientDir ?? "client";
  const emitConfig = raw?.emitConfig ?? preset === "celld";

  const rootAbs = path.resolve(root);
  const outDir = path.resolve(rootAbs, outDirInput);
  const workerEntryAbs = path.resolve(rootAbs, workerEntry);

  assertContained(outDir, path.resolve(outDir, clientDir), "clientDir");

  if (raw?.wrangler) {
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
  };
}

export function tryEmitWranglerConfig(opts: ResolvedOptions, state: EmitState): void {
  if (state.emitted || opts.emitConfig === false) return;

  const wrangler = requireWranglerFields(opts.wrangler);
  const serverFile = path.join(opts.outDir, "server.js");
  const clientDirPath = path.join(opts.outDir, opts.clientDir);

  if (!fs.existsSync(serverFile) || !fs.existsSync(clientDirPath)) return;

  assertContained(opts.outDir, serverFile, "main");
  assertContained(opts.outDir, clientDirPath, "assets.directory");

  const config = {
    name: wrangler.name,
    main: "./server.js",
    compatibility_date: wrangler.compatibility_date,
    ...(wrangler.compatibility_flags ? { compatibility_flags: wrangler.compatibility_flags } : {}),
    ...(wrangler.durable_objects ? { durable_objects: wrangler.durable_objects } : {}),
    ...(wrangler.migrations ? { migrations: wrangler.migrations } : {}),
    ...(wrangler.services ? { services: wrangler.services } : {}),
    ...(wrangler.vars ? { vars: wrangler.vars } : {}),
    assets: {
      directory: `./${opts.clientDir}`,
      binding: "ASSETS",
    },
  };

  fs.writeFileSync(
    path.join(opts.outDir, "wrangler.jsonc"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  state.emitted = true;
}
