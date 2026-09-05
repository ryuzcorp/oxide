import fs from "node:fs";
import path from "node:path";

import { VIRTUAL_WORKER_ID } from "./actions";
import type { ResolvedOptions } from "./types";

interface ViteAlias {
  find: string | RegExp;
  replacement: string;
}

/** Dev aliases so Vite transforms RPC helpers with the app's single effect copy. */
const oxideRpcAliases = function oxideRpcAliases(): ViteAlias[] {
  const root = path.resolve(import.meta.dirname, "..");
  const client = path.join(root, "src/rpc/client.ts");
  if (!fs.existsSync(client)) {
    return [];
  }
  return [
    { find: /^oxidejs\/rpc\/client$/u, replacement: client },
    {
      find: /^oxidejs\/rpc$/u,
      replacement: path.join(root, "src/rpc/index.ts"),
    },
  ];
};

const mergeAliases = function mergeAliases(
  config: ViteUserConfig,
  extra: ViteAlias[]
) {
  if (extra.length === 0) {
    return;
  }
  config.resolve ??= {};
  const current = config.resolve.alias;
  if (!current) {
    config.resolve.alias = extra;
    return;
  }
  if (Array.isArray(current)) {
    config.resolve.alias = [...current, ...extra];
    return;
  }
  config.resolve.alias = [
    ...Object.entries(current).map(([find, replacement]) => ({
      find,
      replacement,
    })),
    ...extra,
  ];
};

/** Minimal Vite config surface used by this plugin. Avoids a hard vite runtime dep. */
export type ViteInput = string | string[] | { [key: string]: string };

export interface ViteBuilder {
  build: (environment: ViteEnvironmentConfig) => Promise<void>;
  environments: { [key: string]: ViteEnvironmentConfig | undefined };
}

export interface ViteUserConfig {
  root?: string;
  appType?: string;
  resolve?: {
    dedupe?: string[];
    alias?: ViteAlias[] | { [key: string]: string };
  };
  optimizeDeps?: { include?: string[] };
  builder?: {
    buildApp?: (builder: ViteBuilder) => Promise<void>;
  };
  environments?: { [key: string]: ViteEnvironmentConfig | undefined };
  build?: {
    outDir?: string;
    manifest?: boolean;
    emptyOutDir?: boolean;
    ssr?: boolean | string;
    rolldownOptions?: { input?: ViteInput };
    rollupOptions?: { input?: ViteInput };
  };
}

export interface ViteEnvironmentConfig {
  consumer?: "client" | "server";
  build?: {
    outDir?: string;
    emptyOutDir?: boolean;
    ssr?: boolean;
    manifest?: boolean;
    input?: ViteInput;
    rolldownOptions?: {
      input?: ViteInput;
      external?: (string | RegExp)[];
      output?: {
        format?: string;
        entryFileNames?: string;
      };
    };
    rollupOptions?: {
      input?: ViteInput;
      external?: (string | RegExp)[];
      output?: {
        format?: string;
        entryFileNames?: string;
      };
    };
  };
  resolve?: { conditions?: string[]; noExternal?: boolean | string[] };
  ssr?: {
    target?: string;
    noExternal?: boolean | string[];
    external?: (string | RegExp)[];
  };
}

// Pre-bundle so Vite does not discover these mid-load and reload the page
// (which aborts in-flight RPC streams). `oxidejs/rpc/client` is imported by
// `virtual:oxide/client` on first action/stream use.
const OPTIMIZE_DEPS = [
  "effect",
  "effect/unstable/rpc",
  "effect/unstable/http",
  "effect/unstable/socket",
  "oxidejs",
  "oxidejs/rpc/client",
] as const;

export const applyViteEnvironments = function applyViteEnvironments(
  config: ViteUserConfig,
  opts: ResolvedOptions
): ViteUserConfig {
  // Opt `vite build` into building every environment (same as `vite build --app`).
  config.builder ??= {};

  config.resolve ??= {};
  const dedupe = new Set([
    ...(Array.isArray(config.resolve.dedupe) ? config.resolve.dedupe : []),
    "effect",
    "oxidejs",
  ]);
  config.resolve.dedupe = [...dedupe];

  config.optimizeDeps ??= {};
  const optimizeInclude = new Set([
    ...(Array.isArray(config.optimizeDeps.include)
      ? config.optimizeDeps.include
      : []),
    ...OPTIMIZE_DEPS,
  ]);
  config.optimizeDeps.include = [...optimizeInclude];

  const celld = opts.preset === "celld";
  mergeAliases(config, oxideRpcAliases());

  config.environments ??= {};

  const ssrBuild = {
    emptyOutDir: true,
    outDir: opts.outDir,
    rolldownOptions: {
      external: celld ? [/^cloudflare:/u] : [],
      input: VIRTUAL_WORKER_ID,
      output: {
        entryFileNames: "server.js",
        format: "es",
      },
    },
    rollupOptions: {
      external: celld ? [/^cloudflare:/u] : [],
      input: VIRTUAL_WORKER_ID,
      output: {
        entryFileNames: "server.js",
        format: "es",
      },
    },
    ssr: true,
  };
  const ssrEnvironment: ViteEnvironmentConfig = {
    build: ssrBuild,
    consumer: "server",
    resolve: celld
      ? { conditions: ["worker"], noExternal: true }
      : { noExternal: ["effect", "oxidejs"] },
    ssr: celld
      ? { external: [/^cloudflare:/u], noExternal: true, target: "webworker" }
      : { noExternal: ["effect", "oxidejs"] },
  };
  config.environments["ssr"] = ssrEnvironment;

  config.build ??= {};
  if (opts.hasClient) {
    const clientOutDir = path.join(opts.outDir, opts.clientDir);
    const existingClient = config.environments["client"];
    config.environments["client"] = {
      ...existingClient,
      build: {
        ...existingClient?.build,
        emptyOutDir: true,
        manifest: true,
        outDir: clientOutDir,
      },
      consumer: "client",
    };
    ssrBuild.emptyOutDir = false;
    config.build.outDir ??= clientOutDir;
    config.build.manifest ??= true;
  } else {
    delete config.environments["client"];
    config.appType = "custom";
    config.build.outDir ??= opts.outDir;
    config.build.emptyOutDir ??= true;
    config.builder.buildApp ??= async (builder) => {
      const server = builder.environments["ssr"];
      if (server) {
        await builder.build(server);
      }
    };
  }
  return config;
};

/** Minimal Rsbuild config surface. Avoids a hard @rsbuild/core runtime dep. */
export interface RsbuildUserConfig {
  root?: string;
  environments?: { [key: string]: RsbuildEnvironmentConfig | undefined };
}

export interface RsbuildEnvironmentConfig {
  source?: {
    entry?: { [key: string]: string | { import: string; html?: boolean } };
  };
  output?: {
    target?: string;
    filename?: string | { js?: string };
    distPath?: { root?: string };
    manifest?: boolean;
  };
  resolve?: { conditionNames?: string[] };
}

export const applyRsbuildEnvironments = function applyRsbuildEnvironments(
  config: RsbuildUserConfig,
  opts: ResolvedOptions
): RsbuildUserConfig {
  config.environments ??= {};
  if (opts.hasClient) {
    const clientOutDir = path.join(opts.outDir, opts.clientDir);
    const existingClient =
      config.environments["web"] ?? config.environments["client"];
    config.environments["web"] = {
      ...existingClient,
      output: {
        ...existingClient?.output,
        distPath: { ...existingClient?.output?.distPath, root: clientOutDir },
        manifest: true,
        target: "web",
      },
    };
  } else {
    delete config.environments["web"];
    delete config.environments["client"];
  }

  const server: RsbuildEnvironmentConfig = {
    output: {
      distPath: { root: opts.outDir },
      filename: { js: "server.js" },
      target: opts.preset === "celld" ? "web-worker" : "node",
    },
    source: { entry: { server: { html: false, import: VIRTUAL_WORKER_ID } } },
  };
  if (opts.preset === "celld") {
    server.resolve = { conditionNames: ["worker", "..."] };
  }
  config.environments["server"] = server;
  return config;
};
