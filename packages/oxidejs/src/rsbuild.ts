import { createEmitState, resolveOptions, tryEmitWranglerConfig } from "./core";
import type { OxidejsOptions, ResolvedOptions } from "./types";

/** Minimal Rsbuild plugin surface. Avoids a hard @rsbuild/core runtime dep. */
export interface RsbuildPlugin {
  name: string;
  setup: (api: RsbuildPluginAPI) => void;
}

export interface RsbuildPluginAPI {
  getRsbuildConfig?: () => { root?: string };
  context?: { rootPath?: string };
  modifyEnvironmentConfig: (
    handler: (
      config: RsbuildEnvironmentConfig,
      utils: { name: string },
    ) => RsbuildEnvironmentConfig | void,
  ) => void;
  onAfterBuild: (handler: () => void) => void;
}

export interface RsbuildEnvironmentConfig {
  output?: {
    target?: string;
    filename?: string | { js?: string };
    distPath?: { root?: string };
  };
}

export function pluginOxidejs(opts: OxidejsOptions = {}): RsbuildPlugin {
  const emitState = createEmitState();
  let resolved: ResolvedOptions | undefined;

  return {
    name: "oxidejs",
    setup(api) {
      const root = api.getRsbuildConfig?.().root ?? api.context?.rootPath ?? process.cwd();
      resolved = resolveOptions(opts, root);
      emitState.emitted = false;

      api.modifyEnvironmentConfig((config, { name }) => {
        if (!resolved || name !== "server") return config;
        config.output ??= {};
        config.output.target = resolved.preset === "celld" ? "web-worker" : "node";
        config.output.filename = "server.js";
        config.output.distPath = {
          ...config.output.distPath,
          root: resolved.outDir,
        };
        return config;
      });

      api.onAfterBuild(() => {
        if (!resolved) return;
        tryEmitWranglerConfig(resolved, emitState);
      });
    },
  };
}

export default pluginOxidejs;
export type { OxidejsOptions } from "./types";
