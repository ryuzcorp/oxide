import path from "node:path";
import { VIRTUAL_WORKER_ID } from "./actions";
import type { ResolvedOptions } from "./types";

/** Minimal Vite config surface used by this plugin. Avoids a hard vite runtime dep. */
export type ViteInput = string | string[] | Record<string, string>;

export interface ViteUserConfig {
  root?: string;
  appType?: string;
  builder?: {
    buildApp?: (builder: {
      environments: Record<string, unknown>;
      build: (environment: unknown) => Promise<unknown>;
    }) => Promise<void>;
  };
  environments?: Record<string, ViteEnvironmentConfig | undefined>;
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
  ssr?: { target?: string; noExternal?: boolean | string[]; external?: (string | RegExp)[] };
}

export function applyViteEnvironments(
  config: ViteUserConfig,
  opts: ResolvedOptions,
): ViteUserConfig {
  // Opt `vite build` into building every environment (same as `vite build --app`).
  config.builder ??= {};

  config.environments ??= {};

  const celld = opts.preset === "celld";
  config.environments["ssr"] = {
    consumer: "server",
    build: {
      outDir: opts.outDir,
      emptyOutDir: true,
      ssr: true,
      rolldownOptions: {
        input: VIRTUAL_WORKER_ID,
        external: celld ? [/^cloudflare:/] : [],
        output: {
          format: "es",
          entryFileNames: "server.js",
        },
      },
      rollupOptions: {
        input: VIRTUAL_WORKER_ID,
        external: celld ? [/^cloudflare:/] : [],
        output: {
          format: "es",
          entryFileNames: "server.js",
        },
      },
    },
    resolve: celld ? { conditions: ["worker"], noExternal: true } : { noExternal: true },
    ssr: celld
      ? { target: "webworker", noExternal: true, external: [/^cloudflare:/] }
      : { noExternal: true },
  };

  config.build ??= {};
  if (opts.hasClient) {
    const clientOutDir = path.join(opts.outDir, opts.clientDir);
    const existingClient = config.environments["client"];
    config.environments["client"] = {
      ...existingClient,
      consumer: "client",
      build: {
        ...existingClient?.build,
        outDir: clientOutDir,
        emptyOutDir: true,
        manifest: true,
      },
    };
    config.environments["ssr"]!.build!.emptyOutDir = false;
    config.build.outDir ??= clientOutDir;
    config.build.manifest ??= true;
  } else {
    delete config.environments["client"];
    config.appType = "custom";
    config.build.outDir ??= opts.outDir;
    config.build.emptyOutDir ??= true;
    config.builder.buildApp ??= async (builder) => {
      const server = builder.environments["ssr"];
      if (server) await builder.build(server);
    };
  }
  return config;
}

/** Minimal Rsbuild config surface. Avoids a hard @rsbuild/core runtime dep. */
export interface RsbuildUserConfig {
  root?: string;
  environments?: Record<string, RsbuildEnvironmentConfig | undefined>;
}

export interface RsbuildEnvironmentConfig {
  source?: { entry?: Record<string, string | { import: string; html?: boolean }> };
  output?: {
    target?: string;
    filename?: string | { js?: string };
    distPath?: { root?: string };
    manifest?: boolean;
  };
  resolve?: { conditionNames?: string[] };
}

export function applyRsbuildEnvironments(
  config: RsbuildUserConfig,
  opts: ResolvedOptions,
): RsbuildUserConfig {
  config.environments ??= {};
  if (opts.hasClient) {
    const clientOutDir = path.join(opts.outDir, opts.clientDir);
    const existingClient = config.environments["web"] ?? config.environments["client"];
    config.environments["web"] = {
      ...existingClient,
      output: {
        ...existingClient?.output,
        target: "web",
        distPath: { ...existingClient?.output?.distPath, root: clientOutDir },
        manifest: true,
      },
    };
  } else {
    delete config.environments["web"];
    delete config.environments["client"];
  }

  const server: RsbuildEnvironmentConfig = {
    source: { entry: { server: { import: VIRTUAL_WORKER_ID, html: false } } },
    output: {
      target: opts.preset === "celld" ? "web-worker" : "node",
      filename: { js: "server.js" },
      distPath: { root: opts.outDir },
    },
  };
  if (opts.preset === "celld") server.resolve = { conditionNames: ["worker", "..."] };
  config.environments["server"] = server;
  return config;
}

/** @deprecated Use applyViteEnvironments. Kept for existing call sites. */
export const applyViteWorkerEnvironment = applyViteEnvironments;
