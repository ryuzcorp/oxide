/* eslint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-unknown-returns, anti-slop/no-unknown-parameters -- celld wrangler snapshots are untyped JSON bags at the deploy boundary */
import fs from "node:fs";
import path from "node:path";

import { mergeDurableBindings } from "./core";
import type { DurableWranglerConfig } from "./core";

export { mergeDurableBindings } from "./core";
export type { DurableWranglerConfig } from "./core";

type CloudflareConfigCustomizer = (
  config: DurableWranglerConfig,
  ...args: unknown[]
) => DurableWranglerConfig | undefined;

interface ViteEnvironmentOptions {
  childEnvironments?: string[];
  name?: string;
}

/**
 * Higher-order options for `@cloudflare/vite-plugin`'s `cloudflare()` —
 * defaults `viteEnvironment.name` to `"ssr"` and runs `mergeDurableBindings`
 * before any user `config` object / function.
 *
 * Pass `root` when the Vite project root is not `process.cwd()` (stripped
 * before options reach Cloudflare).
 *
 * ```ts
 * cloudflare(withOxide())
 * cloudflare(withOxide({ root: import.meta.dirname }))
 * cloudflare(withOxide({ config: (c) => { … } }))
 * ```
 */
export const withOxide = function withOxide<T extends object>(
  // SAFETY: empty options are valid; callers omit the arg for merge-only.
  options: T & { root?: string } = {} as T
): Omit<T, "config" | "root" | "viteEnvironment"> & {
  config: CloudflareConfigCustomizer;
  viteEnvironment: ViteEnvironmentOptions;
} {
  // SAFETY: optional Cloudflare `config` is object | function | undefined.
  const userConfig =
    "config" in options
      ? (
          options as {
            config?: DurableWranglerConfig | CloudflareConfigCustomizer;
          }
        ).config
      : undefined;
  // SAFETY: optional `viteEnvironment` bag from Cloudflare plugin options.
  const userEnv =
    "viteEnvironment" in options
      ? (options as { viteEnvironment?: ViteEnvironmentOptions })
          .viteEnvironment
      : undefined;
  const root =
    "root" in options && typeof options.root === "string"
      ? options.root
      : process.cwd();
  // SAFETY: strip oxide-only `root` / rewritten `config` / `viteEnvironment` before spreading into Cloudflare options.
  const rest = { ...options } as T & {
    config?: unknown;
    root?: string;
    viteEnvironment?: unknown;
  };
  delete rest.config;
  delete rest.root;
  delete rest.viteEnvironment;
  return {
    ...rest,
    config: (config, ...args) => {
      mergeDurableBindings(config, root);
      if (typeof userConfig === "function") {
        return userConfig(config, ...args);
      }
      return userConfig;
    },
    viteEnvironment: {
      name: "ssr",
      ...userEnv,
    },
  };
};

/**
 * Top-level wrangler keys `celld deploy` / `celld dev` accept
 * (see celld `SUPPORTED_KEYS` in deploy.rs).
 */
export const CELLD_WRANGLER_KEYS = [
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "durable_objects",
  "migrations",
  "assets",
  "services",
  "triggers",
  "vars",
  "d1_databases",
  "kv_namespaces",
  "queues",
  "workflows",
  "r2_buckets",
  // Intentionally omit `no_bundle`: Cloudflare Vite sets it so Wrangler skips
  // esbuild, but celld only stubs `node:*` / `cloudflare:*` — relative chunk
  // imports (`./assets/…`) fail at load. Dropping it makes celld esbuild a
  // single module.
] as const;

export type CelldWranglerKey = (typeof CELLD_WRANGLER_KEYS)[number];

/** Parsed wrangler snapshot (allowlisted keys kept; nested values stay unknown). */
export interface CelldWranglerConfig {
  [key: string]: unknown;
}

const CELLD_KEY_SET = new Set<string>(CELLD_WRANGLER_KEYS);

/**
 * Keep only keys celld accepts. Use on the Cloudflare Vite plugin's build
 * snapshot before rewriting paths for `celld deploy` / `celld dev`.
 */
export const toCelldWrangler = function toCelldWrangler(
  config: CelldWranglerConfig
): CelldWranglerConfig {
  const out: CelldWranglerConfig = {};
  for (const key of CELLD_WRANGLER_KEYS) {
    if (Object.hasOwn(config, key) && config[key] !== undefined) {
      out[key] = config[key];
    }
  }
  return out;
};

/** True when `key` is rejected by `celld deploy`. */
export const isCelldUnsupportedKey = function isCelldUnsupportedKey(
  key: string
): boolean {
  return !CELLD_KEY_SET.has(key);
};

const isPlainObject = function isPlainObject(
  value: unknown
): value is CelldWranglerConfig {
  return Object.prototype.toString.call(value) === "[object Object]";
};

const asString = function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
};

/** celld rejects any path with `..` or absolute segments. */
const isCelldSafeRelativePath = function isCelldSafeRelativePath(
  value: string
): boolean {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized.length === 0) {
    return false;
  }
  return normalized
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
};

/**
 * Resolve `fromDir`-relative `relativePath` as a path under `projectRoot`.
 * Returns undefined when the result escapes the project (celld forbids `..`).
 */
const relocateUnderProject = function relocateUnderProject(
  projectRoot: string,
  fromDir: string,
  relativePath: string
): string | undefined {
  const absolute = path.resolve(fromDir, relativePath);
  const relocated = path.relative(projectRoot, absolute);
  if (!isCelldSafeRelativePath(relocated)) {
    return;
  }
  return relocated.split(path.sep).join("/");
};

/**
 * Rewrite a Cloudflare Vite (`dist/ssr/wrangler.json`) snapshot so celld can
 * deploy `dist/` as the project root: `main` → `ssr/…`, `assets.directory` →
 * `client`, and drop escaping `migrations_dir` values.
 */
export const relocateCloudflareViteWrangler =
  function relocateCloudflareViteWrangler(
    config: CelldWranglerConfig,
    distDir: string
  ): CelldWranglerConfig {
    const projectRoot = path.resolve(distDir);
    const ssrDir = path.join(projectRoot, "ssr");
    const cleaned = toCelldWrangler(config);

    const mainIn = asString(cleaned["main"]);
    if (mainIn !== undefined) {
      const main = relocateUnderProject(projectRoot, ssrDir, mainIn);
      if (main) {
        cleaned["main"] = main;
      } else {
        delete cleaned["main"];
      }
    }

    if (isPlainObject(cleaned["assets"])) {
      const assets = { ...cleaned["assets"] };
      const directoryIn = asString(assets["directory"]);
      if (directoryIn !== undefined) {
        const directory = relocateUnderProject(
          projectRoot,
          ssrDir,
          directoryIn
        );
        if (directory) {
          assets["directory"] = directory;
        } else {
          delete assets["directory"];
        }
      }
      cleaned["assets"] = assets;
    }

    if (Array.isArray(cleaned["d1_databases"])) {
      cleaned["d1_databases"] = cleaned["d1_databases"].map((entry) => {
        if (!isPlainObject(entry)) {
          return entry;
        }
        const migrationsIn = asString(entry["migrations_dir"]);
        if (migrationsIn === undefined) {
          return entry;
        }
        const migrationsDir = relocateUnderProject(
          projectRoot,
          ssrDir,
          migrationsIn
        );
        if (!migrationsDir) {
          const { migrations_dir: _drop, ...rest } = entry;
          return rest;
        }
        return { ...entry, migrations_dir: migrationsDir };
      });
    }

    return cleaned;
  };

/** Cloudflare Vite drops these into the asset root; celld rejects them. */
const CELLD_ASSET_STRIP = [".assetsignore"] as const;

/**
 * Parse a Wrangler-style `.dev.vars` / dotenv file into string vars.
 * Lines that are empty or `#` comments are ignored. Values may be quoted.
 */
export const parseDevVars = function parseDevVars(
  source: string
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      continue;
    }
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
};

/**
 * Merge project `.dev.vars` into wrangler `vars` for celld (which does not
 * load `.dev.vars` the way `wrangler dev` does). Existing wrangler vars win.
 */
export const mergeDevVarsIntoConfig = function mergeDevVarsIntoConfig(
  config: CelldWranglerConfig,
  distDir: string
): CelldWranglerConfig {
  const projectRoot = path.dirname(path.resolve(distDir));
  const candidates = [
    path.join(projectRoot, ".dev.vars"),
    path.join(process.cwd(), ".dev.vars"),
  ];
  let fileVars: Record<string, string> | undefined;
  for (const file of candidates) {
    if (!fs.existsSync(file)) {
      continue;
    }
    fileVars = parseDevVars(fs.readFileSync(file, "utf-8"));
    break;
  }
  if (!fileVars || Object.keys(fileVars).length === 0) {
    return config;
  }
  const existing = isPlainObject(config["vars"]) ? config["vars"] : {};
  // .dev.vars are strings; wrangler JSON vars (numbers, booleans, objects) win.
  return {
    ...config,
    vars: { ...fileVars, ...existing },
  };
};

/**
 * Bare side-effect `import "node:…"` leftovers from the Cloudflare/unenv graph.
 * celld 0.4.x has no stub for `node:fs` (docs list it as partial later); unused
 * `node:path` side-effect imports are dropped too. Named imports are kept.
 */
const CELLD_BARE_NODE_IMPORT_STRIP = ["node:fs", "node:path"] as const;

const stripCelldUnsupportedAssets = function stripCelldUnsupportedAssets(
  distDir: string,
  assetsDirectory: string
): void {
  for (const name of CELLD_ASSET_STRIP) {
    const target = path.join(distDir, assetsDirectory, name);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
  }
};

/** Remove unused bare `import "node:fs"` / `import "node:path"` lines. */
export const stripCelldBareNodeImports = function stripCelldBareNodeImports(
  source: string
): string {
  let out = source;
  for (const spec of CELLD_BARE_NODE_IMPORT_STRIP) {
    out = out.replaceAll(`import "${spec}";\n`, "");
    out = out.replaceAll(`import '${spec}';\n`, "");
    out = out.replaceAll(`import "${spec}";\r\n`, "");
    out = out.replaceAll(`import '${spec}';\r\n`, "");
  }
  return out;
};

const relocateRelativeSpecifier = function relocateRelativeSpecifier(
  spec: string,
  fromDir: string,
  toDir: string
) {
  const absolute = path.resolve(fromDir, spec);
  let relocated = path.relative(toDir, absolute).split(path.sep).join("/");
  if (!(relocated.startsWith("./") || relocated.startsWith("../"))) {
    relocated = `./${relocated}`;
  }
  return relocated;
};

const skipLineComment = function skipLineComment(
  source: string,
  start: number
) {
  let i = start + 2;
  while (i < source.length && source[i] !== "\n") {
    i += 1;
  }
  return i;
};

const skipBlockComment = function skipBlockComment(
  source: string,
  start: number
) {
  let i = start + 2;
  while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
    i += 1;
  }
  return Math.min(i + 2, source.length);
};

const skipStringLiteral = function skipStringLiteral(
  source: string,
  start: number
) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) {
      return i + 1;
    }
    if (quote === "`" && source[i] === "$" && source[i + 1] === "{") {
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "{") {
          depth += 1;
        } else if (source[i] === "}") {
          depth -= 1;
        }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return i;
};

const FROM_SPEC_RE = /^from\s+(?<quote>["'])(?<spec>\.[^"']+)\k<quote>/u;
const IMPORT_CALL_SPEC_RE =
  /^import\s*\(\s*(?<quote>["'])(?<spec>\.[^"']+)\k<quote>/u;
const IMPORT_SIDE_SPEC_RE =
  /^import\s+(?<quote>["'])(?<spec>\.[^"']+)\k<quote>/u;

const tryRewriteModuleSpecifierAt = function tryRewriteModuleSpecifierAt(
  source: string,
  index: number,
  fromDir: string,
  toDir: string
): { length: number; text: string } | undefined {
  if (index > 0 && /[\w$]/u.test(source[index - 1] ?? "")) {
    return undefined;
  }
  const rest = source.slice(index);
  const fromMatch = FROM_SPEC_RE.exec(rest);
  if (fromMatch?.groups) {
    const quote = fromMatch.groups["quote"] ?? '"';
    const spec = fromMatch.groups["spec"] ?? "";
    return {
      length: fromMatch[0].length,
      text: `from ${quote}${relocateRelativeSpecifier(spec, fromDir, toDir)}${quote}`,
    };
  }
  const callMatch = IMPORT_CALL_SPEC_RE.exec(rest);
  if (callMatch?.groups) {
    const quote = callMatch.groups["quote"] ?? '"';
    const spec = callMatch.groups["spec"] ?? "";
    return {
      length: callMatch[0].length,
      text: `import(${quote}${relocateRelativeSpecifier(spec, fromDir, toDir)}${quote}`,
    };
  }
  const sideMatch = IMPORT_SIDE_SPEC_RE.exec(rest);
  if (sideMatch?.groups) {
    const quote = sideMatch.groups["quote"] ?? '"';
    const spec = sideMatch.groups["spec"] ?? "";
    return {
      length: sideMatch[0].length,
      text: `import ${quote}${relocateRelativeSpecifier(spec, fromDir, toDir)}${quote}`,
    };
  }
  return undefined;
};

/**
 * Rewrite relative `import` / `export` specifiers so a file moved to `toDir`
 * still resolves modules that lived next to the original under `fromDir`.
 *
 * Only rewrites real module dependency string literals (`from "…"`,
 * `import("…")`, side-effect `import "…"`). Strings and comments are skipped
 * so import-shaped text inside a string literal stays unchanged.
 */
export const rewriteRelativeModuleSpecifiers =
  function rewriteRelativeModuleSpecifiers(
    source: string,
    fromDir: string,
    toDir: string
  ): string {
    const fromResolved = path.resolve(fromDir);
    const toResolved = path.resolve(toDir);
    if (fromResolved === toResolved) {
      return source;
    }
    let result = "";
    let i = 0;
    while (i < source.length) {
      const c0 = source[i];
      const c1 = source[i + 1];
      if (c0 === "/" && c1 === "/") {
        const end = skipLineComment(source, i);
        result += source.slice(i, end);
        i = end;
        continue;
      }
      if (c0 === "/" && c1 === "*") {
        const end = skipBlockComment(source, i);
        result += source.slice(i, end);
        i = end;
        continue;
      }
      const rewritten = tryRewriteModuleSpecifierAt(
        source,
        i,
        fromResolved,
        toResolved
      );
      if (rewritten) {
        result += rewritten.text;
        i += rewritten.length;
        continue;
      }
      if (c0 === '"' || c0 === "'" || c0 === "`") {
        const end = skipStringLiteral(source, i);
        result += source.slice(i, end);
        i = end;
        continue;
      }
      result += c0;
      i += 1;
    }
    return result;
  };

/**
 * Write a stripped Worker entry under `celld/` (not beside Cloudflare's
 * `ssr/` main) and return a project-relative main path.
 */
const writeCelldWorkerEntry = function writeCelldWorkerEntry(
  projectRoot: string,
  mainRelative: string
): string {
  if (!isCelldSafeRelativePath(mainRelative)) {
    throw new Error(
      `oxidejs: celld main must be a path inside the deploy root (got ${JSON.stringify(mainRelative)})`
    );
  }
  const mainAbs = path.join(projectRoot, mainRelative);
  const resolvedMain = path.resolve(mainAbs);
  const rootResolved = path.resolve(projectRoot);
  if (
    resolvedMain !== rootResolved &&
    !resolvedMain.startsWith(`${rootResolved}${path.sep}`)
  ) {
    throw new Error(
      `oxidejs: celld main escapes the deploy root (got ${JSON.stringify(mainRelative)})`
    );
  }
  const celldDir = path.join(projectRoot, "celld");
  fs.mkdirSync(celldDir, { recursive: true });
  const celldEntryAbs = path.join(celldDir, "entry.js");
  const entrySource = fs.readFileSync(mainAbs, "utf-8");
  const stripped = stripCelldBareNodeImports(entrySource);
  const rewritten = rewriteRelativeModuleSpecifiers(
    stripped,
    path.dirname(mainAbs),
    celldDir
  );
  fs.writeFileSync(celldEntryAbs, rewritten);
  return "celld/entry.js";
};

/**
 * Read the Cloudflare Vite wrangler snapshot under `dist/ssr`, strip unsupported
 * keys, relocate paths for a `dist/` deploy root, and write `dist/wrangler.json`.
 * Also removes Cloudflare-only asset files celld rejects (e.g. `.assetsignore`)
 * and rewrites `main` to `celld/entry.js` without bare `node:fs` / `node:path`
 * side-effect imports (kept outside `ssr/` so Cloudflare deploy does not upload it).
 */
export const prepareCelldDeploy = function prepareCelldDeploy(
  distDir = "dist"
): CelldWranglerConfig {
  const root = path.resolve(distDir);
  const sourcePath = path.join(root, "ssr", "wrangler.json");
  const outPath = path.join(root, "wrangler.json");
  const source = fs.readFileSync(sourcePath, "utf-8");
  // SAFETY: Cloudflare Vite build snapshot is JSON (not JSONC).
  const parsed = JSON.parse(source) as CelldWranglerConfig;
  const cleaned = mergeDevVarsIntoConfig(
    relocateCloudflareViteWrangler(parsed, root),
    root
  );

  const main = asString(cleaned["main"]);
  if (main === undefined) {
    throw new Error(
      "oxidejs: celld deploy needs a Worker main inside dist/ (relocation may have dropped an escaping path)"
    );
  }
  cleaned["main"] = writeCelldWorkerEntry(root, main);

  fs.writeFileSync(outPath, `${JSON.stringify(cleaned, null, 2)}\n`);

  const assets = isPlainObject(cleaned["assets"])
    ? cleaned["assets"]
    : undefined;
  const assetsDirectory = asString(assets?.["directory"]) ?? "client";
  if (!isCelldSafeRelativePath(assetsDirectory)) {
    throw new Error(
      `oxidejs: celld assets.directory must be inside the deploy root (got ${JSON.stringify(assetsDirectory)})`
    );
  }
  stripCelldUnsupportedAssets(root, assetsDirectory);

  return cleaned;
};

/** Run {@link prepareCelldDeploy} when a Cloudflare Vite `ssr/wrangler.json` snapshot exists. */
export const maybePrepareCelldDeploy = function maybePrepareCelldDeploy(
  distDir = "dist"
): CelldWranglerConfig | undefined {
  const snapshot = path.join(path.resolve(distDir), "ssr", "wrangler.json");
  if (!fs.existsSync(snapshot)) {
    return;
  }
  return prepareCelldDeploy(distDir);
};

/**
 * @deprecated Prefer {@link prepareCelldDeploy} for Cloudflare Vite layouts.
 * Read a wrangler JSON snapshot, strip celld-unsupported keys, write it back.
 */
export const writeCelldWrangler = function writeCelldWrangler(
  filePath: string
): CelldWranglerConfig {
  const source = fs.readFileSync(filePath, "utf-8");
  // SAFETY: wrangler build snapshot is JSON (not JSONC).
  const parsed = JSON.parse(source) as CelldWranglerConfig;
  const cleaned = toCelldWrangler(parsed);
  fs.writeFileSync(filePath, `${JSON.stringify(cleaned, null, 2)}\n`);
  return cleaned;
};
