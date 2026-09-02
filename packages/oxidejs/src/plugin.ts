import { createUnplugin } from "unplugin";
import type { UnpluginFactory } from "unplugin";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  generateActionsClientModule,
  generateActionsModule,
  generateClientModule,
  generateClientStub,
  generateWorkerWrapper,
  isServerFileId,
  loadClientStub,
  matchesActionPath,
  moduleKey,
  nodeToWebRequest,
  parseExportedNames,
  pluginShouldStub,
  RequestBodyTooLargeError,
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
import { createActionHandler, createWsHooks } from "./rpc";
import type { OxidejsOptions, ResolvedOptions } from "./types";
import {
  applyRsbuildEnvironments,
  applyViteEnvironments,
  type RsbuildUserConfig,
  type ViteUserConfig,
} from "./worker-build";
import { ensureWorkerDom } from "./worker-dom";

type ConnectReq = IncomingMessage;
type ConnectRes = ServerResponse;
type ConnectNext = (err?: unknown) => void;

type RpcDevModule = {
  createActionHandler: typeof createActionHandler;
  createWsHooks: typeof createWsHooks;
};

function actionMiddleware(
  loadRouter: () => Promise<{ default: unknown; actionsHandlers: unknown }>,
  loadRpc: () => Promise<RpcDevModule>,
  path: string,
  sameOrigin: boolean,
  bodyLimit: number,
  onError?: (error: unknown) => void,
) {
  return (req: ConnectReq, res: ConnectRes, next: ConnectNext) => {
    if (!matchesActionPath((req.url ?? "").split("?")[0] ?? "", path)) {
      next();
      return;
    }
    void (async () => {
      const [mod, rpc] = await Promise.all([loadRouter(), loadRpc()]);
      const handler = rpc.createActionHandler(mod.default as never, mod.actionsHandlers as never, {
        path,
        ...(sameOrigin ? { sameOrigin: true } : {}),
      });
      const response = await handler(await nodeToWebRequest(req, bodyLimit));
      await sendWebResponseFrom(req, res, response);
    })().catch((error) => {
      if (res.headersSent) return;
      if (error instanceof RequestBodyTooLargeError) {
        res.statusCode = 413;
        res.end();
        return;
      }
      onError?.(error);
      // Never fall through to Vite's HTML/404 stack for action POSTs — that
      // surfaces as a misleading empty 404 when the SSR graph is still cold.
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "oxide action handler failed" }));
    });
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
  loadRouter: () => Promise<{ default: unknown; actionsHandlers: unknown }>,
  loadRpc: () => Promise<RpcDevModule>,
  path: string,
  sameOrigin: boolean,
) {
  if (!httpServer) return;
  const crosswsNode = "crossws/adapters/node";
  void import(/* @vite-ignore */ crosswsNode).then(({ default: crossws }) => {
    httpServer.on("upgrade", (req, socket, head) => {
      if (!matchesActionPath((req.url ?? "").split("?")[0] ?? "", path)) return;
      void Promise.all([loadRouter(), loadRpc()])
        .then(([mod, rpc]) =>
          crossws({
            hooks: rpc.createWsHooks(mod.default as never, mod.actionsHandlers as never, {
              path,
              sameOrigin,
            }),
          }).handleUpgrade(req, socket as never, head),
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
    actionsHandlers: unknown;
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
      if (id === RESOLVED_VIRTUAL_WORKER_ID && pluginShouldStub(this, extra)) {
        throw new Error(`oxidejs: ${VIRTUAL_WORKER_ID} is server-only`);
      }
      if (id === RESOLVED_VIRTUAL_ACTIONS_ID) {
        const modules = scanServerFiles(resolved?.root ?? process.cwd());
        if (pluginShouldStub(this, extra)) return generateActionsClientModule(modules);
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
          middleware: resolved.middleware as never,
          imports: resolved.imports,
          bodyLimit: resolved.bodyLimit,
          notFound: resolved.notFound,
          env: resolved.env,
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
        if (resolved?.preset === "celld") {
          ensureWorkerDom();
          // Celld builds target Workers, but dev SSR runs on Node. Worker export
          // conditions and noExternal:true pull in CJS deps (e.g. buffer-image-size)
          // that call `require` and break ilha frame renders.
          const ssr = server.environments.ssr;
          const resolve = ssr?.config?.resolve;
          if (resolve) {
            resolve.conditions = ["node", "import", "module", "default"];
            resolve.noExternal = ["effect", "oxidejs"];
          }
          const ssrOpts = ssr?.config?.ssr;
          if (ssrOpts && typeof ssrOpts === "object") {
            ssrOpts.target = "node";
            ssrOpts.noExternal = ["effect", "oxidejs"];
          }
        }
        const invalidateActions = () => {
          for (const env of Object.values(server.environments)) {
            const mod = env.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ACTIONS_ID);
            if (mod) void env.moduleGraph.invalidateModule(mod);
          }
        };
        const fetchRouter = async () => {
          const mod = (await server.ssrLoadModule(VIRTUAL_ACTIONS_ID)) as {
            default: unknown;
            actionsHandlers: unknown;
          };
          return mod;
        };
        // Lazy + clear-on-reject: never leave a rejected promise cached (sticky 503)
        // and never start a follow-up fetch nobody awaits (uncaught rejection → crash).
        let routerReady: Promise<{ default: unknown; actionsHandlers: unknown }> | undefined;
        const loadRouter = () => {
          const current = (routerReady ??= fetchRouter());
          return current.catch((error) => {
            if (routerReady === current) routerReady = undefined;
            throw error;
          });
        };
        const refreshRouter = () => {
          routerReady = undefined;
        };
        server.watcher.on("all", (_event, file) => {
          if (isServerFileId(file)) {
            invalidateActions();
            refreshRouter();
          }
        });
        const loadRpc = () => server.ssrLoadModule("oxidejs/rpc") as Promise<RpcDevModule>;
        const logActionError = (error: unknown) => {
          server.config.logger.error("oxidejs: action handler failed: " + String(error));
        };
        const wireActions = () =>
          server.middlewares.use(
            actionMiddleware(
              loadRouter,
              loadRpc,
              resolved!.actionPath,
              resolved!.actionSameOrigin,
              resolved!.bodyLimit,
              logActionError,
            ),
          );

        if (resolved?.actions === "ws") {
          attachActionUpgrade(
            server.httpServer,
            loadRouter,
            loadRpc,
            resolved.actionPath,
            resolved.actionSameOrigin,
          );
          return async () => {
            try {
              await loadRouter();
            } catch (error) {
              server.config.logger.error("oxidejs: failed to prewarm actions: " + String(error));
            }
          };
        }

        // Register both the production-middleware bridge and /__oxide/action
        // synchronously so they land before Vite's HTML fallback. Loading the
        // middleware modules is async; the bridge awaits that on first use.
        // Deferring `middlewares.use` until after `ssrLoadModule` used to put
        // actions behind Vite's catch-all → empty 404 on POST /__oxide/action.
        type MwHandler = (
          request: Request,
          context: { env: unknown; ctx: unknown },
        ) => Promise<Response | undefined>;
        let handlersPromise: Promise<MwHandler[]> = Promise.resolve([]);

        if ((resolved?.middleware?.length ?? 0) > 0 || (resolved?.imports?.length ?? 0) > 0) {
          handlersPromise = (async () => {
            try {
              for (const spec of resolved!.imports ?? []) await server.ssrLoadModule(spec);
              const handlers: MwHandler[] = [];
              for (const entry of resolved!.middleware ?? []) {
                const spec = typeof entry === "string" ? entry : entry.module;
                const mod = (await server.ssrLoadModule(spec)) as {
                  default?: (
                    request: Request,
                    context: { env: unknown; ctx: unknown },
                  ) => Response | undefined | Promise<Response | undefined>;
                };
                if (typeof mod.default !== "function") continue;
                const fn = mod.default;
                handlers.push((request, context) => Promise.resolve(fn(request, context)));
              }
              return handlers;
            } catch (error) {
              server.config.logger.error(
                "oxidejs: failed to wire dev middleware: " + String(error),
              );
              return [];
            }
          })();

          server.middlewares.use((creq, cres, next) => {
            // Don't touch /__oxide/action — reading the body here would empty the
            // Node stream before the action middleware runs.
            if (matchesActionPath((creq.url ?? "").split("?")[0] ?? "", resolved!.actionPath)) {
              next();
              return;
            }
            void (async () => {
              try {
                const handlers = await handlersPromise;
                if (handlers.length === 0) {
                  next();
                  return;
                }
                const { nodeToWebRequest, sendWebResponseFrom } = await import("./actions");
                const request = await nodeToWebRequest(creq, resolved!.bodyLimit);
                const context = { env: resolved!.env, ctx: undefined };
                for (const handler of handlers) {
                  const hit = await handler(request, context);
                  if (hit) {
                    await sendWebResponseFrom(creq, cres, hit);
                    return;
                  }
                }
                next();
              } catch (error) {
                if (cres.headersSent) return;
                cres.statusCode = error instanceof RequestBodyTooLargeError ? 413 : 500;
                cres.end(error instanceof RequestBodyTooLargeError ? undefined : String(error));
              }
            })();
          });
        }

        wireActions();

        // Prewarm the SSR action router (and production middleware imports)
        // before Vite prints "ready", so the first client hydration RPC does
        // not race a cold `ssrLoadModule("virtual:oxide/actions")`.
        return async () => {
          try {
            await loadRouter();
            await handlersPromise;
          } catch (error) {
            server.config.logger.error("oxidejs: failed to prewarm dev server: " + String(error));
          }
        };
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
            return loadActions(root);
          };
          const loadRpc = async (): Promise<RpcDevModule> => ({
            createActionHandler,
            createWsHooks,
          });
          if (resolved?.actions === "ws")
            attachActionUpgrade(
              server.httpServer,
              loadRouter,
              loadRpc,
              resolved.actionPath,
              resolved.actionSameOrigin,
            );
          else
            server.middlewares.use(
              actionMiddleware(
                loadRouter,
                loadRpc,
                resolved!.actionPath,
                resolved!.actionSameOrigin,
                resolved!.bodyLimit,
              ),
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
