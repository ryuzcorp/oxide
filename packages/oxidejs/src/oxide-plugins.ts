/* eslint-disable anti-slop/no-runtime-typeof -- plugin inputs are string | OxidePlugin at the options boundary */
/* eslint-disable no-await-in-loop -- plugins must run in declared order */
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  OxideBuildContext,
  OxidePlugin,
  OxidePluginInput,
  ResolvedOptions,
} from "./types";

const isPluginObject = function isPluginObject(
  value: unknown
): value is OxidePlugin {
  if (value === null || typeof value !== "object") {
    return false;
  }
  // SAFETY: narrowed to object; probe optional hook/name fields only.
  const candidate = value as {
    afterBuild?: unknown;
    beforeBuild?: unknown;
    name?: unknown;
  };
  return (
    typeof candidate.beforeBuild === "function" ||
    typeof candidate.afterBuild === "function" ||
    typeof candidate.name === "string"
  );
};

/** Resolve a plugin module id against the app root (relative / absolute paths). */
export const resolvePluginModuleId = function resolvePluginModuleId(
  input: string,
  root: string
) {
  if (input.startsWith(".") || path.isAbsolute(input)) {
    return pathToFileURL(path.resolve(root, input)).href;
  }
  return input;
};

/** Load string module IDs; pass objects through. */
export const resolveOxidePlugins = async function resolveOxidePlugins(
  inputs: OxidePluginInput[],
  root: string = process.cwd()
): Promise<OxidePlugin[]> {
  const out: OxidePlugin[] = [];
  for (const input of inputs) {
    if (typeof input !== "string") {
      out.push(input);
      continue;
    }
    const mod: unknown = await import(resolvePluginModuleId(input, root));
    let candidate: unknown = mod;
    if (mod && typeof mod === "object" && "default" in mod) {
      // SAFETY: ES module namespace — `default` is the plugin export we asked for.
      candidate = (mod as { default: unknown }).default;
    }
    if (!isPluginObject(candidate)) {
      throw new Error(
        `oxidejs: plugin ${JSON.stringify(input)} must default-export an OxidePlugin`
      );
    }
    out.push(candidate);
  }
  return out;
};

export const toOxideBuildContext = function toOxideBuildContext(
  opts: ResolvedOptions
): OxideBuildContext {
  return {
    outDir: opts.outDir,
    preset: opts.preset,
    root: opts.root,
  };
};

export const runOxidePluginHook = async function runOxidePluginHook(
  plugins: OxidePlugin[],
  hook: "beforeBuild" | "afterBuild",
  ctx: OxideBuildContext
): Promise<void> {
  for (const plugin of plugins) {
    const fn = plugin[hook];
    if (!fn) {
      continue;
    }
    await fn(ctx);
  }
};

/**
 * Run `afterBuild` once the environment that finishes last for this layout
 * has closed — client when present, otherwise the server/SSR worker env.
 */
export const shouldRunAfterBuild = function shouldRunAfterBuild(
  environmentName: string | undefined,
  hasClient: boolean
) {
  if (hasClient) {
    return environmentName === "client";
  }
  return (
    environmentName === undefined ||
    environmentName === "ssr" ||
    environmentName === "server"
  );
};
