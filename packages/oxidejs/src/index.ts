import { createUnplugin } from "unplugin";
import type { UnpluginFactory } from "unplugin";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  generateActionsModule,
  generateClientModule,
  generateClientStub,
  generateWorkerWrapper,
  isServerFileId,
  loadClientStub,
  moduleKey,
  nodeToWebRequest,
  parseExportedNames,
  pluginShouldStub,
  RESOLVED_VIRTUAL_ACTIONS_ID,
  RESOLVED_VIRTUAL_CLIENT_ID,
  RESOLVED_VIRTUAL_WORKER_ID,
  scanServerFiles,
  sendWebResponseFrom,
  VIRTUAL_ACTIONS_ID,
  VIRTUAL_CLIENT_ID,
  VIRTUAL_WORKER_ID,
} from "./actions";
import { copyPublicDir, createEmitState, resolveOptions, tryEmitWranglerConfig } from "./core";
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

function actionMiddleware(loadRouter: () => Promise<unknown>, path: string, sameOrigin: boolean) {
  return (req: ConnectReq, res: ConnectRes, next: ConnectNext) => {
    if ((req.url ?? "").split("?")[0] !== path) {
      next();
      return;
    }
    void (async () => {
      const tachoFetch = "tacho/transport/fetch";
      const { handle } = await import(/* @vite-ignore */ tachoFetch);
      const response = await handle(await loadRouter(), {
        path,
        ...(sameOrigin ? { sameOrigin: true } : {}),
      })(await nodeToWebRequest(req));
      await sendWebResponseFrom(req, res, response);
    })().catch(next);
  };
}

function attachActionUpgrade(
  httpServer:
    | {
        on(
          event: "upgrade",
          listener: (req: IncomingMessage, socket: { destroy(): void }, head: Buffer) => void,
        ): void;
      }
    | null
    | undefined,
  loadRouter: () => Promise<unknown>,
  path: string,
  sameOrigin: boolean,
) {
  if (!httpServer) return;
  const tachoWs = "tacho/transport/ws";
  const crosswsNode = "crossws/adapters/node";
  void Promise.all([
    import(/* @vite-ignore */ tachoWs),
    import(/* @vite-ignore */ crosswsNode),
  ]).then(([{ handle }, { default: crossws }]) => {
    httpServer.on("upgrade", (req, socket, head) => {
      if ((req.url ?? "").split("?")[0] !== path) return;
      void loadRouter()
        .then((router) =>
          crossws({ hooks: handle(router, { path, sameOrigin }) }).handleUpgrade(
            req,
            socket as never,
            head,
          ),
        )
        .catch(() => {
          socket.destroy();
        });
    });
  });
}

function previewMiddleware(file: string) {
  return (req: ConnectReq, res: ConnectRes, next: ConnectNext) => {
    void (async () => {
      const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
        default: { fetch: (request: Request) => Promise<Response> };
      };
      await sendWebResponseFrom(req, res, await mod.default.fetch(await nodeToWebRequest(req)));
    })().catch(next);
  };
}

interface RsbuildServer {
  middlewares: { use: (fn: (req: ConnectReq, res: ConnectRes, next: ConnectNext) => void) => void };
  httpServer?: {
    on(
      event: "upgrade",
      listener: (req: IncomingMessage, socket: { destroy(): void }, head: Buffer) => void,
    ): void;
  };
}

interface RsbuildPluginApi {
  modifyRsbuildConfig: (fn: (config: RsbuildUserConfig) => void) => void;
  onBeforeStartDevServer: (fn: (ctx: { server: RsbuildServer }) => void) => void;
  onBeforeStartPreviewServer?: (fn: (ctx: { server: RsbuildServer }) => void) => void;
}

function loadActions(root: string) {
  const code = generateActionsModule(scanServerFiles(root), { bust: true });
  return import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(code)}`) as Promise<{
    default: unknown;
  }>;
}

export const unpluginFactory: UnpluginFactory<OxidejsOptions | undefined> = (options) => {
  let resolved: ResolvedOptions | undefined;
  const emitState = createEmitState();

  return {
    name: "oxidejs",
    enforce: "pre",
    buildStart() {
      resolved ??= resolveOptions(options, process.cwd());
      emitState.emitted = false;
    },
    resolveId(id) {
      if (id === VIRTUAL_ACTIONS_ID) return RESOLVED_VIRTUAL_ACTIONS_ID;
      if (id === VIRTUAL_WORKER_ID) return RESOLVED_VIRTUAL_WORKER_ID;
      if (id === VIRTUAL_CLIENT_ID) return RESOLVED_VIRTUAL_CLIENT_ID;
      return null;
    },
    load(id, extra?: { ssr?: boolean }) {
      if (id === RESOLVED_VIRTUAL_CLIENT_ID) {
        const transport =
          resolved?.actions ??
          (typeof options?.actions === "string" || options?.actions === undefined
            ? (options?.actions as "http" | "ws" | undefined)
            : options.actions.transport) ??
          "http";
        return generateClientModule(
          transport,
          resolved?.actionHeaders ?? options?.actionHeaders,
          resolved?.actionPath,
        );
      }
      if (id === RESOLVED_VIRTUAL_ACTIONS_ID || id === RESOLVED_VIRTUAL_WORKER_ID) {
        if (pluginShouldStub(this, extra)) {
          throw new Error(
            `oxidejs: ${id === RESOLVED_VIRTUAL_ACTIONS_ID ? VIRTUAL_ACTIONS_ID : VIRTUAL_WORKER_ID} is server-only`,
          );
        }
      }
      if (id === RESOLVED_VIRTUAL_ACTIONS_ID) {
        const modules = scanServerFiles(resolved?.root ?? process.cwd());
        for (const mod of modules) this.addWatchFile(mod.abs);
        return generateActionsModule(modules);
      }
      if (id === RESOLVED_VIRTUAL_WORKER_ID) {
        if (!resolved) return;
        this.addWatchFile(resolved.workerEntryAbs);
        const modules = scanServerFiles(resolved.root);
        for (const mod of modules) this.addWatchFile(mod.abs);
        return generateWorkerWrapper(resolved.workerEntryAbs, {
          preset: resolved.preset,
          clientDir: resolved.clientDir,
          hasClient: resolved.hasClient,
          hasPublic: resolved.hasPublic,
          hasActions: modules.length > 0,
          actions: resolved.actions,
          actionPath: resolved.actionPath,
          actionSameOrigin: resolved.actionSameOrigin,
          middleware: resolved.middleware,
        });
      }
      if (isServerFileId(id) && pluginShouldStub(this, extra)) {
        const file = id.split("?")[0] ?? id;
        this.addWatchFile(file);
        return loadClientStub(id);
      }
      return;
    },
    transform(code, id, extra?: { ssr?: boolean }) {
      if (
        !isServerFileId(id) ||
        !pluginShouldStub(this, extra) ||
        code.startsWith("// oxidejs:client-stub\n")
      )
        return;
      return generateClientStub({
        key: moduleKey(id.split("?")[0] ?? id),
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
        const loadRouter = async () => {
          const mod = (await server.ssrLoadModule(VIRTUAL_ACTIONS_ID)) as { default: unknown };
          return mod.default;
        };
        if (resolved?.actions === "ws")
          attachActionUpgrade(
            server.httpServer,
            loadRouter,
            resolved.actionPath,
            resolved.actionSameOrigin,
          );
        else
          server.middlewares.use(
            actionMiddleware(loadRouter, resolved!.actionPath, resolved!.actionSameOrigin),
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
          const loadRouter = async () => {
            const root = resolved?.root ?? process.cwd();
            return (await loadActions(root)).default;
          };
          if (resolved?.actions === "ws")
            attachActionUpgrade(
              server.httpServer,
              loadRouter,
              resolved.actionPath,
              resolved.actionSameOrigin,
            );
          else
            server.middlewares.use(
              actionMiddleware(loadRouter, resolved!.actionPath, resolved!.actionSameOrigin),
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
      copyPublicDir(resolved);
      tryEmitWranglerConfig(resolved, emitState);
    },
  };
};

export const oxidejs = /* @__PURE__ */ createUnplugin(unpluginFactory);

export const vite = /* @__PURE__ */ (() => oxidejs.vite)();

export default oxidejs;
export { action, useCtx, useEnv, useFetchCtx, useRequest } from "./context";
export type { ActionContext, ActionOptions, ExecutionContext } from "./context";
export type {
  OxidejsActionHeaders,
  OxidejsActionTransport,
  OxidejsOptions,
  OxidejsPreset,
  OxidejsWranglerOptions,
  ResolvedOptions,
} from "./types";
