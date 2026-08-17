import { createUnplugin } from "unplugin";
import type { UnpluginFactory } from "unplugin";
import type { IncomingMessage, ServerResponse } from "node:http";
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
  sendWebResponseFrom,
  shouldStubServerModule,
  VIRTUAL_ACTIONS_ID,
  VIRTUAL_WORKER_ID,
} from "./actions";
import { createEmitState, resolveOptions, tryEmitWranglerConfig } from "./core";
import type { OxidejsOptions, ResolvedOptions } from "./types";
import {
  applyRsbuildEnvironments,
  applyViteEnvironments,
  type RsbuildUserConfig,
  type ViteUserConfig,
} from "./worker-build";

type ConnectReq = IncomingMessage;
type ConnectRes = ServerResponse;
type ConnectNext = (err?: unknown) => void;

function actionMiddleware(loadRouter: () => Promise<unknown>) {
  return (req: ConnectReq, res: ConnectRes, next: ConnectNext) => {
    if ((req.url ?? "").split("?")[0] !== ACTION_PATH) {
      next();
      return;
    }
    void (async () => {
      const { handle } = await import("tacho/transport/fetch");
      const response = await handle(await loadRouter(), { path: ACTION_PATH })(
        await nodeToWebRequest(req),
      );
      await sendWebResponseFrom(req, res, response);
    })().catch(next);
  };
}

function previewMiddleware(file: string) {
  return (req: ConnectReq, res: ConnectRes, next: ConnectNext) => {
    void (async () => {
      const mod = (await import(pathToFileURL(file).href)) as {
        default: { fetch: (request: Request) => Promise<Response> };
      };
      await sendWebResponseFrom(req, res, await mod.default.fetch(await nodeToWebRequest(req)));
    })().catch(next);
  };
}

interface RsbuildServer {
  middlewares: { use: (fn: (req: ConnectReq, res: ConnectRes, next: ConnectNext) => void) => void };
}

interface RsbuildPluginApi {
  modifyRsbuildConfig: (fn: (config: RsbuildUserConfig) => void) => void;
  onBeforeStartDevServer: (fn: (ctx: { server: RsbuildServer }) => void) => void;
  onBeforeStartPreviewServer?: (fn: (ctx: { server: RsbuildServer }) => void) => void;
}

export const unpluginFactory: UnpluginFactory<OxidejsOptions | undefined> = (options) => {
  let resolved: ResolvedOptions | undefined;
  const emitState = createEmitState();

  return {
    name: "oxidejs",
    buildStart() {
      resolved ??= resolveOptions(options, process.cwd());
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
          hasClient: resolved.hasClient,
        });
      }
      return;
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
    vite: {
      config(config) {
        const root = typeof config.root === "string" ? config.root : process.cwd();
        resolved = resolveOptions(options, root, config);
        applyViteEnvironments(config as ViteUserConfig, resolved);
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
        server.middlewares.use(
          actionMiddleware(async () => {
            const mod = (await server.ssrLoadModule(VIRTUAL_ACTIONS_ID)) as { default: unknown };
            return mod.default;
          }),
        );
      },
      configurePreviewServer(server) {
        if (resolved?.preset !== "fetch") return;
        server.middlewares.use(previewMiddleware(path.join(resolved.outDir, "server.js")));
      },
    },
    rsbuild: {
      setup(api: RsbuildPluginApi) {
        api.modifyRsbuildConfig((config) => {
          const root = typeof config.root === "string" ? config.root : process.cwd();
          resolved = resolveOptions(options, root, config);
          applyRsbuildEnvironments(config, resolved);
        });
        api.onBeforeStartDevServer(({ server }) => {
          server.middlewares.use(
            actionMiddleware(async () => {
              const root = resolved?.root ?? process.cwd();
              const code = generateActionsModule(scanServerFiles(root));
              const data = `data:text/javascript,${encodeURIComponent(code)}`;
              const mod = (await import(data)) as { default: unknown };
              return mod.default;
            }),
          );
        });
        api.onBeforeStartPreviewServer?.(({ server }) => {
          if (resolved?.preset !== "fetch") return;
          server.middlewares.use(previewMiddleware(path.join(resolved.outDir, "server.js")));
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
