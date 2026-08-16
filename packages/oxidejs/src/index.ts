import { createUnplugin } from "unplugin";
import type { UnpluginFactory } from "unplugin";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ACTION_PATH,
  generateActionsModule,
  generateClientStub,
  generateWorkerWrapper,
  isServerFileId,
  moduleKey,
  nodeToWebRequest,
  parseExportedNames,
  RESOLVED_VIRTUAL_ACTIONS_ID,
  RESOLVED_VIRTUAL_WORKER_ID,
  scanServerFiles,
  sendWebResponse,
  shouldStubServerModule,
  VIRTUAL_ACTIONS_ID,
  VIRTUAL_WORKER_ID,
} from "./actions";
import { createEmitState, resolveOptions, tryEmitWranglerConfig } from "./core";
import type { OxidejsOptions, ResolvedOptions } from "./types";
import { applyViteEnvironments, type ViteUserConfig } from "./worker-build";

export const unpluginFactory: UnpluginFactory<OxidejsOptions | undefined> = (options) => {
  let resolved: ResolvedOptions | undefined;
  const emitState = createEmitState();

  return {
    name: "oxidejs",
    buildStart() {
      resolved = resolveOptions(options, process.cwd());
      emitState.emitted = false;
    },
    resolveId(id) {
      if (id === VIRTUAL_ACTIONS_ID) return RESOLVED_VIRTUAL_ACTIONS_ID;
      if (id === VIRTUAL_WORKER_ID) return RESOLVED_VIRTUAL_WORKER_ID;
      return null;
    },
    load(id) {
      if (id === RESOLVED_VIRTUAL_ACTIONS_ID) {
        const modules = scanServerFiles(resolved?.root ?? process.cwd());
        for (const mod of modules) this.addWatchFile(mod.abs);
        return generateActionsModule(modules);
      }
      if (id === RESOLVED_VIRTUAL_WORKER_ID) {
        if (!resolved) return;
        this.addWatchFile(resolved.workerEntryAbs);
        return generateWorkerWrapper(resolved.workerEntryAbs, {
          preset: resolved.preset,
          clientDir: resolved.clientDir,
        });
      }
      return;
    },
    vite: {
      config(config) {
        const root = typeof config.root === "string" ? config.root : process.cwd();
        resolved = resolveOptions(options, root);
        applyViteEnvironments(config as ViteUserConfig, resolved);
      },
      transform(code, id) {
        const environment = (this as { environment?: { name?: string; consumer?: string } })
          .environment;
        if (!isServerFileId(id) || !shouldStubServerModule(environment)) return;
        const file = id.split("?")[0] ?? id;
        return generateClientStub({
          key: moduleKey(file),
          exports: parseExportedNames(code),
        });
      },
      configureServer(server) {
        const invalidateActions = () => {
          for (const env of Object.values(server.environments)) {
            const mod = env.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ACTIONS_ID);
            if (mod) void env.moduleGraph.invalidateModule(mod);
          }
        };
        server.watcher.on("all", (_event, file) => {
          if (isServerFileId(file)) invalidateActions();
        });
        server.middlewares.use((req, res, next) => {
          if ((req.url ?? "").split("?")[0] !== ACTION_PATH) {
            next();
            return;
          }
          void (async () => {
            const { handle } = await import("tacho/transport/fetch");
            const mod = (await server.ssrLoadModule(VIRTUAL_ACTIONS_ID)) as {
              default: unknown;
            };
            const response = await handle(mod.default, { path: ACTION_PATH })(
              await nodeToWebRequest(req),
            );
            await sendWebResponse(res, response);
          })().catch(next);
        });
      },
      configurePreviewServer(server) {
        if (resolved?.preset !== "fetch") return;
        const file = path.join(resolved.outDir, "server.js");
        server.middlewares.use((req, res, next) => {
          void (async () => {
            const mod = (await import(pathToFileURL(file).href)) as {
              default: { fetch: (request: Request) => Promise<Response> };
            };
            await sendWebResponse(res, await mod.default.fetch(await nodeToWebRequest(req)));
          })().catch(next);
        });
      },
    },
    writeBundle() {
      if (!resolved) return;
      tryEmitWranglerConfig(resolved, emitState);
    },
  };
};

export const oxidejs = createUnplugin(unpluginFactory);

export const vite = oxidejs.vite;

export default oxidejs;
export type {
  OxidejsOptions,
  OxidejsPreset,
  OxidejsWranglerOptions,
  ResolvedOptions,
} from "./types";
