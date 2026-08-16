import path from "node:path";
import { VIRTUAL_WORKER_ID } from "./actions";
import type { ResolvedOptions } from "./types";

/** Minimal Vite config surface used by this plugin. Avoids a hard vite runtime dep. */
export interface ViteUserConfig {
  root?: string;
  builder?: object;
  environments?: Record<string, ViteEnvironmentConfig | undefined>;
  build?: {
    outDir?: string;
    manifest?: boolean;
    emptyOutDir?: boolean;
  };
}

export interface ViteEnvironmentConfig {
  consumer?: "client" | "server";
  build?: {
    outDir?: string;
    emptyOutDir?: boolean;
    ssr?: boolean;
    manifest?: boolean;
    rollupOptions?: {
      input?: string;
      output?: {
        format?: string;
        entryFileNames?: string;
      };
    };
  };
  resolve?: { conditions?: string[]; noExternal?: boolean | string[] };
  ssr?: { target?: string; noExternal?: boolean | string[] };
}

export function applyViteEnvironments(
  config: ViteUserConfig,
  opts: ResolvedOptions,
): ViteUserConfig {
  // Opt `vite build` into building every environment (same as `vite build --app`).
  config.builder ??= {};

  config.environments ??= {};

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

  const celld = opts.preset === "celld";
  config.environments["server"] = {
    consumer: "server",
    build: {
      outDir: opts.outDir,
      emptyOutDir: false,
      ssr: true,
      rollupOptions: {
        input: VIRTUAL_WORKER_ID,
        output: {
          format: "es",
          entryFileNames: "server.js",
        },
      },
    },
    resolve: celld ? { conditions: ["worker"], noExternal: true } : { noExternal: true },
    ssr: celld ? { target: "webworker", noExternal: true } : { noExternal: true },
  };

  // Keep top-level build.outDir aligned with the client environment for tools
  // that still read the legacy field.
  config.build ??= {};
  config.build.outDir ??= clientOutDir;
  config.build.manifest ??= true;
  return config;
}

/** @deprecated Use applyViteEnvironments. Kept for existing call sites. */
export const applyViteWorkerEnvironment = applyViteEnvironments;
