import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createUnplugin } from "unplugin";
import type { UnpluginFactory } from "unplugin";

import {
  generateActionsClientModule,
  generateActionsModule,
  generateClientModule,
  generateClientStub,
  generateWorkerWrapper,
  isServerFileId,
  loadClientStub,
  bypassesDevMiddlewareBridge,
  matchesActionPath,
  moduleKey,
  nodeToWebRequest,
  parseExportedNames,
  parseStreamExports,
  pluginShouldStub,
  RequestBodyTooLargeError,
  RESOLVED_VIRTUAL_ACTIONS_ID,
  RESOLVED_VIRTUAL_CLIENT_ID,
  RESOLVED_VIRTUAL_QUEUES_ID,
  RESOLVED_VIRTUAL_SCHEDULES_ID,
  RESOLVED_VIRTUAL_WORKER_ID,
  RESOLVED_VIRTUAL_WORKFLOWS_ID,
  scanServerFiles,
  sendWebResponseFrom,
  VIRTUAL_ACTIONS_ID,
  VIRTUAL_CLIENT_ID,
  VIRTUAL_QUEUES_ID,
  VIRTUAL_SCHEDULES_ID,
  VIRTUAL_WORKER_ID,
  VIRTUAL_WORKFLOWS_ID,
} from "./actions";
import { copyPublicDir, resolveOptions } from "./core";
import {
  createOpenRpcResponse,
  matchesOpenRpcPath,
  OPENRPC_PATH,
} from "./openrpc";
import type { OpenRpcActionEntry } from "./openrpc";
import {
  resolveOxidePlugins,
  runOxidePluginHook,
  shouldRunAfterBuild,
  toOxideBuildContext,
} from "./oxide-plugins";
import {
  assertQueueCollisions,
  generateQueueHandlerModule,
  parseQueueExports,
  resolveQueueWorkflowRefs,
  scanQueueFiles,
} from "./queue-build";
import { createActionHandler, createWsHooks } from "./rpc";
import {
  assertScheduleCollisions,
  generateScheduleHandlerModule,
  parseScheduleExports,
  resolveScheduleRefs,
  scanScheduleFiles,
} from "./schedule-build";
import type { OxidejsOptions, OxidePlugin, ResolvedOptions } from "./types";
import {
  applyRsbuildEnvironments,
  applyViteEnvironments,
} from "./worker-build";
import type { RsbuildUserConfig } from "./worker-build";
import {
  assertWorkflowActionCollisions,
  generateWorkflowClassesModule,
  parseWorkflowExports,
  scanWorkflowFiles,
} from "./workflow-build";
import { maybePrepareCelldDeploy } from "./wrangler";

const scanDurableModules = function scanDurableModules(root: string) {
  const modules = scanServerFiles(root);
  const workflows = scanWorkflowFiles(root);
  const queues = scanQueueFiles(root);
  resolveQueueWorkflowRefs(queues, workflows);
  const schedules = scanScheduleFiles(root);
  resolveScheduleRefs(schedules, workflows, queues);
  assertWorkflowActionCollisions(modules, workflows);
  assertQueueCollisions(modules, workflows, queues);
  assertScheduleCollisions(modules, workflows, queues, schedules);
  return { modules, queues, schedules, workflows };
};

type ConnectReq = IncomingMessage;
type ConnectRes = ServerResponse;
type ConnectNext = (err?: Error) => void;

interface RpcDevModule {
  createActionHandler: typeof createActionHandler;
  createWsHooks: typeof createWsHooks;
}

interface UpgradeSocket {
  destroy: () => void;
}

interface HttpUpgradeServer {
  on: (
    event: "upgrade",
    listener: (
      req: IncomingMessage,
      socket: UpgradeSocket,
      head: Buffer
    ) => void
  ) => void;
}

interface PluginHookContext {
  addWatchFile: (id: string) => void;
  environment?: {
    config?: { consumer?: string };
    consumer?: string;
    name?: string;
  };
  getNativeBuildContext?: () => {
    compiler?: {
      name?: string;
      options?: { name?: string; target?: string | string[] };
    };
  };
}

interface MiddlewareContext {
  ctx: undefined;
  env: ResolvedOptions["env"];
}

type MiddlewareDefault = (
  request: Request,
  context: MiddlewareContext
) => Response | undefined | Promise<Response | undefined>;

type MwHandler = (
  request: Request,
  context: MiddlewareContext
) => Promise<Response | undefined>;

interface MiddlewareModule {
  default?: MiddlewareDefault;
}

interface DevSsrServer {
  config: { logger: { error: (msg: string) => void } };
  ssrLoadModule: (id: string) => Promise<MiddlewareModule>;
}

const isString = function isString(value: unknown): value is string {
  return typeof value === "string";
};

const isMiddlewareDefault = function isMiddlewareDefault(
  value: unknown
): value is MiddlewareDefault {
  return typeof value === "function";
};

const resolveActionTransport = function resolveActionTransport(
  resolved: ResolvedOptions | undefined,
  options: OxidejsOptions | undefined
): "http" | "ws" {
  if (resolved?.actions) {
    return resolved.actions;
  }
  const actions = options?.actions;
  if (isString(actions) || actions === undefined) {
    return actions ?? "http";
  }
  return actions.transport ?? "http";
};

const loadRpcModule = function loadRpcModule(): Promise<RpcDevModule> {
  return Promise.resolve({
    createActionHandler,
    createWsHooks,
  });
};

const actionMiddleware = function actionMiddleware(
  loadRouter: () => Promise<{ actionsHandlers: unknown; default: unknown }>,
  loadRpc: () => Promise<RpcDevModule>,
  actionPath: string,
  sameOrigin: boolean,
  bodyLimit: number,
  onError?: (error: Error) => void
) {
  return (req: ConnectReq, res: ConnectRes, next: ConnectNext) => {
    if (!matchesActionPath((req.url ?? "").split("?")[0] ?? "", actionPath)) {
      return next();
    }
    void (async () => {
      try {
        const [mod, rpc] = await Promise.all([loadRouter(), loadRpc()]);
        // SAFETY: Effect RpcGroup default export + handlers layer are opaque to the plugin; createActionHandler owns the runtime contract.
        const handler = rpc.createActionHandler(
          mod.default as never,
          mod.actionsHandlers as never,
          {
            path: actionPath,
            sameOrigin,
          }
        );
        const response = await handler(await nodeToWebRequest(req, bodyLimit));
        await sendWebResponseFrom(req, res, response);
      } catch (error) {
        if (res.headersSent) {
          return;
        }
        if (error instanceof RequestBodyTooLargeError) {
          res.statusCode = 413;
          res.end();
          return;
        }
        onError?.(error instanceof Error ? error : new Error(String(error)));
        // Never fall through to Vite's HTML/404 stack for action POSTs —
        // that surfaces as a misleading empty 404 when the SSR graph is still cold.
        res.statusCode = 503;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "oxide action handler failed" }));
      }
    })();
  };
};

const openRpcMiddleware = function openRpcMiddleware(
  loadRouter: () => Promise<{
    actionsOpenRpcEntries?: OpenRpcActionEntry[];
  }>,
  actionPath: string,
  bodyLimit: number
) {
  return (req: ConnectReq, res: ConnectRes, next: ConnectNext) => {
    if (
      !matchesOpenRpcPath((req.url ?? "").split("?")[0] ?? "", OPENRPC_PATH)
    ) {
      return next();
    }
    void (async () => {
      try {
        const mod = await loadRouter();
        const response = createOpenRpcResponse(
          mod.actionsOpenRpcEntries ?? [],
          await nodeToWebRequest(req, bodyLimit),
          { actionPath }
        );
        await sendWebResponseFrom(req, res, response);
      } catch {
        if (res.headersSent) {
          return;
        }
        res.statusCode = 503;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "oxide openrpc handler failed" }));
      }
    })();
  };
};

const attachActionUpgrade = function attachActionUpgrade(
  httpServer: HttpUpgradeServer | null | undefined,
  loadRouter: () => Promise<{ actionsHandlers: unknown; default: unknown }>,
  loadRpc: () => Promise<RpcDevModule>,
  actionPath: string,
  sameOrigin: boolean
) {
  if (!httpServer) {
    return;
  }
  const crosswsNode = "crossws/adapters/node";
  void (async () => {
    const { default: crossws } = await import(
      /* @vite-ignore */
      crosswsNode
    );
    httpServer.on("upgrade", (req, socket, head) => {
      if (!matchesActionPath((req.url ?? "").split("?")[0] ?? "", actionPath)) {
        return;
      }
      void (async () => {
        try {
          const [mod, rpc] = await Promise.all([loadRouter(), loadRpc()]);
          // SAFETY: Effect RpcGroup default export + handlers layer are opaque; createWsHooks owns the runtime contract.
          const hooks = rpc.createWsHooks(
            mod.default as never,
            mod.actionsHandlers as never,
            {
              path: actionPath,
              sameOrigin,
            }
          );
          // SAFETY: Node upgrade socket is a Duplex; crossws handleUpgrade accepts the broader net.Socket shape.
          await crossws({ hooks }).handleUpgrade(req, socket as never, head);
        } catch {
          socket.destroy();
        }
      })();
    });
  })();
};

const previewMiddleware = function previewMiddleware(file: string) {
  return (req: ConnectReq, res: ConnectRes, next: ConnectNext) => {
    void (async () => {
      try {
        // SAFETY: dist/server.js default export is the generated fetch app; preview only runs after a successful build.
        const mod = (await import(
          /* @vite-ignore */
          pathToFileURL(file).href
        )) as {
          default: { fetch: (request: Request) => Promise<Response> };
        };
        await sendWebResponseFrom(
          req,
          res,
          await mod.default.fetch(await nodeToWebRequest(req))
        );
      } catch (error) {
        return next(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  };
};

interface RsbuildServer {
  httpServer?: HttpUpgradeServer;
  middlewares: {
    use: (
      fn: (req: ConnectReq, res: ConnectRes, next: ConnectNext) => void
    ) => void;
  };
}

interface RsbuildPluginApi {
  modifyRsbuildConfig: (fn: (config: RsbuildUserConfig) => void) => void;
  onAfterBuild?: (fn: () => void | Promise<void>) => void;
  onBeforeBuild?: (fn: () => void | Promise<void>) => void;
  onBeforeStartDevServer: (
    fn: (ctx: { server: RsbuildServer }) => void
  ) => void;
  onBeforeStartPreviewServer?: (
    fn: (ctx: { server: RsbuildServer }) => void
  ) => void;
}

const loadActions = function loadActions(root: string) {
  const { modules, queues, workflows } = scanDurableModules(root);
  const code = generateActionsModule(modules, {
    bust: true,
    queues,
    workflows,
  });
  const dir = fs.mkdtempSync(path.join(root, ".oxide-actions-"));
  const file = path.join(dir, "actions.mjs");
  fs.writeFileSync(file, code);
  return (async () => {
    try {
      // SAFETY: generated actions.mjs exports RpcGroup default + actionsHandlers; dynamic import has no static module type.
      return (await import(pathToFileURL(file).href)) as {
        actionsHandlers: unknown;
        actionsOpenRpcEntries?: OpenRpcActionEntry[];
        default: unknown;
      };
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  })();
};

const loadVirtualClient = function loadVirtualClient(
  resolved: ResolvedOptions | undefined,
  options: OxidejsOptions | undefined
): string {
  const transport = resolveActionTransport(resolved, options);
  return generateClientModule(
    transport,
    resolved?.actionHeaders ?? options?.actionHeaders,
    resolved?.actionPath
  );
};

const loadVirtualActions = function loadVirtualActions(
  ctx: PluginHookContext,
  resolved: ResolvedOptions | undefined,
  extra?: { ssr?: boolean }
): string {
  const root = resolved?.root ?? process.cwd();
  const { modules, queues, schedules, workflows } = scanDurableModules(root);
  if (pluginShouldStub(ctx, extra)) {
    return generateActionsClientModule(modules, workflows, queues);
  }
  for (const mod of modules) {
    ctx.addWatchFile(mod.abs);
  }
  for (const mod of workflows) {
    ctx.addWatchFile(mod.abs);
  }
  for (const mod of queues) {
    ctx.addWatchFile(mod.abs);
  }
  for (const mod of schedules) {
    ctx.addWatchFile(mod.abs);
  }
  return generateActionsModule(modules, { queues, workflows });
};

const loadVirtualWorkflows = function loadVirtualWorkflows(
  ctx: PluginHookContext,
  resolved: ResolvedOptions | undefined
): string {
  const workflows = scanWorkflowFiles(resolved?.root ?? process.cwd());
  for (const mod of workflows) {
    ctx.addWatchFile(mod.abs);
  }
  return generateWorkflowClassesModule(workflows);
};

const loadVirtualQueues = function loadVirtualQueues(
  ctx: PluginHookContext,
  resolved: ResolvedOptions | undefined
): string {
  const root = resolved?.root ?? process.cwd();
  const { queues } = scanDurableModules(root);
  for (const mod of queues) {
    ctx.addWatchFile(mod.abs);
  }
  return generateQueueHandlerModule(queues);
};

const loadVirtualSchedules = function loadVirtualSchedules(
  ctx: PluginHookContext,
  resolved: ResolvedOptions | undefined
): string {
  const root = resolved?.root ?? process.cwd();
  const { schedules } = scanDurableModules(root);
  for (const mod of schedules) {
    ctx.addWatchFile(mod.abs);
  }
  return generateScheduleHandlerModule(schedules);
};

const loadVirtualWorker = function loadVirtualWorker(
  ctx: PluginHookContext,
  resolved: ResolvedOptions
): string {
  // Re-check at load so a default entry created after config resolve is picked up.
  const hasEntry = fs.existsSync(resolved.workerEntryAbs);
  if (hasEntry) {
    ctx.addWatchFile(resolved.workerEntryAbs);
  } else {
    ctx.addWatchFile(path.dirname(resolved.workerEntryAbs));
  }
  const { modules, queues, schedules, workflows } = scanDurableModules(
    resolved.root
  );
  for (const mod of modules) {
    ctx.addWatchFile(mod.abs);
  }
  for (const mod of workflows) {
    ctx.addWatchFile(mod.abs);
  }
  for (const mod of queues) {
    ctx.addWatchFile(mod.abs);
  }
  for (const mod of schedules) {
    ctx.addWatchFile(mod.abs);
  }
  return generateWorkerWrapper(hasEntry ? resolved.workerEntryAbs : null, {
    actionOpenRpc: resolved.actionOpenRpc,
    actionPath: resolved.actionPath,
    actionSameOrigin: resolved.actionSameOrigin,
    actions: resolved.actions,
    bodyLimit: resolved.bodyLimit,
    clientDir: resolved.clientDir,
    env: resolved.env,
    hasActions: modules.length > 0 || workflows.length > 0 || queues.length > 0,
    hasClient: resolved.hasClient,
    hasPublic: resolved.hasPublic,
    hasQueues: queues.length > 0,
    hasSchedules: schedules.length > 0,
    imports: resolved.imports,
    // SAFETY: ResolvedOptions.middleware matches WorkerWrapperOpts.middleware (string | { module, imports? }).
    middleware: resolved.middleware as never,
    notFound: resolved.notFound,
    preset: resolved.preset,
    workflowClassNames: workflows.flatMap((mod) =>
      mod.exports.map((exp) => exp.className)
    ),
  });
};

const loadPluginModule = function loadPluginModule(
  ctx: PluginHookContext,
  id: string,
  resolved: ResolvedOptions | undefined,
  options: OxidejsOptions | undefined,
  extra?: { ssr?: boolean }
): string | undefined {
  if (id === RESOLVED_VIRTUAL_CLIENT_ID) {
    return loadVirtualClient(resolved, options);
  }
  if (id === RESOLVED_VIRTUAL_WORKER_ID && pluginShouldStub(ctx, extra)) {
    throw new Error(`oxidejs: ${VIRTUAL_WORKER_ID} is server-only`);
  }
  if (id === RESOLVED_VIRTUAL_WORKFLOWS_ID && pluginShouldStub(ctx, extra)) {
    throw new Error(`oxidejs: ${VIRTUAL_WORKFLOWS_ID} is server-only`);
  }
  if (id === RESOLVED_VIRTUAL_QUEUES_ID && pluginShouldStub(ctx, extra)) {
    throw new Error(`oxidejs: ${VIRTUAL_QUEUES_ID} is server-only`);
  }
  if (id === RESOLVED_VIRTUAL_SCHEDULES_ID && pluginShouldStub(ctx, extra)) {
    throw new Error(`oxidejs: ${VIRTUAL_SCHEDULES_ID} is server-only`);
  }
  if (id === RESOLVED_VIRTUAL_ACTIONS_ID) {
    return loadVirtualActions(ctx, resolved, extra);
  }
  if (id === RESOLVED_VIRTUAL_WORKFLOWS_ID) {
    return loadVirtualWorkflows(ctx, resolved);
  }
  if (id === RESOLVED_VIRTUAL_QUEUES_ID) {
    return loadVirtualQueues(ctx, resolved);
  }
  if (id === RESOLVED_VIRTUAL_SCHEDULES_ID) {
    return loadVirtualSchedules(ctx, resolved);
  }
  if (id === RESOLVED_VIRTUAL_WORKER_ID) {
    if (!resolved) {
      return;
    }
    return loadVirtualWorker(ctx, resolved);
  }
  if (isServerFileId(id) && pluginShouldStub(ctx, extra)) {
    const file = id.split("?")[0] ?? id;
    ctx.addWatchFile(file);
    return loadClientStub(id);
  }
  return undefined;
};

const runMiddlewareHandlers = async function runMiddlewareHandlers(
  handlers: MwHandler[],
  request: Request,
  context: MiddlewareContext,
  index: number
): Promise<Response | undefined> {
  if (index >= handlers.length) {
    return;
  }
  const handler = handlers[index];
  if (!handler) {
    return runMiddlewareHandlers(handlers, request, context, index + 1);
  }
  const hit = await handler(request, context);
  if (hit) {
    return hit;
  }
  return runMiddlewareHandlers(handlers, request, context, index + 1);
};

const loadDevMiddlewareHandlers = async function loadDevMiddlewareHandlers(
  server: DevSsrServer,
  resolved: ResolvedOptions
): Promise<MwHandler[]> {
  try {
    await Promise.all(
      (resolved.imports ?? []).map((spec) => server.ssrLoadModule(spec))
    );
    const entries = resolved.middleware ?? [];
    const mods = await Promise.all(
      entries.map(async (entry) => {
        const spec = isString(entry) ? entry : entry.module;
        // SAFETY: user middleware modules export a default request handler; shape checked below.
        return (await server.ssrLoadModule(spec)) as MiddlewareModule;
      })
    );
    const handlers: MwHandler[] = [];
    for (const mod of mods) {
      if (!isMiddlewareDefault(mod.default)) {
        continue;
      }
      const fn = mod.default;
      handlers.push((request, context) =>
        Promise.resolve(fn(request, context))
      );
    }
    return handlers;
  } catch (error) {
    server.config.logger.error(
      `oxidejs: failed to wire dev middleware: ${String(error)}`
    );
    return [];
  }
};

/** Register the Connect bridge that runs production middleware modules in Vite dev. */
const attachDevMiddlewareBridge = function attachDevMiddlewareBridge(
  server: DevSsrServer & {
    middlewares: {
      use: (
        handler: (req: ConnectReq, res: ConnectRes, next: ConnectNext) => void
      ) => void;
    };
  },
  opts: ResolvedOptions
): Promise<MwHandler[]> {
  if (
    (opts.middleware?.length ?? 0) === 0 &&
    (opts.imports?.length ?? 0) === 0
  ) {
    return Promise.resolve([]);
  }
  const handlersPromise = loadDevMiddlewareHandlers(server, opts);
  server.middlewares.use((creq, cres, next) => {
    // Don't touch /__oxide/action — reading the body here would empty the
    // Node stream before the action middleware runs. OpenRPC stays in this
    // bridge so auth middleware can reject discovery the same as production.
    if (
      bypassesDevMiddlewareBridge(
        (creq.url ?? "").split("?")[0] ?? "",
        opts.actionPath
      )
    ) {
      return next();
    }
    void (async () => {
      try {
        const handlers = await handlersPromise;
        if (handlers.length === 0) {
          return next();
        }
        const request = await nodeToWebRequest(creq, opts.bodyLimit);
        const context: MiddlewareContext = {
          ctx: undefined,
          env: opts.env,
        };
        const hit = await runMiddlewareHandlers(handlers, request, context, 0);
        if (hit) {
          await sendWebResponseFrom(creq, cres, hit);
          return;
        }
        return next();
      } catch (error) {
        if (cres.headersSent) {
          return;
        }
        cres.statusCode = error instanceof RequestBodyTooLargeError ? 413 : 500;
        cres.end(
          error instanceof RequestBodyTooLargeError ? undefined : String(error)
        );
      }
    })();
  });
  return handlersPromise;
};

export const unpluginFactory: UnpluginFactory<OxidejsOptions | undefined> = (
  options
) => {
  let resolved: ResolvedOptions | undefined;
  let oxidePlugins: OxidePlugin[] = [];
  /** Which adapter owns production build hooks — avoids double-firing on Rsbuild. */
  let buildHost: "vite" | "rsbuild" | null = null;
  let viteProductionBuild = false;
  let beforeBuildRan = false;
  let afterBuildRan = false;

  const loadPlugins = async function loadPlugins() {
    if (!resolved) {
      return;
    }
    oxidePlugins = await resolveOxidePlugins(resolved.plugins, resolved.root);
  };

  const runBeforeBuild = async function runBeforeBuild() {
    if (!resolved || beforeBuildRan) {
      return;
    }
    beforeBuildRan = true;
    await loadPlugins();
    await runOxidePluginHook(
      oxidePlugins,
      "beforeBuild",
      toOxideBuildContext(resolved)
    );
  };

  const runAfterBuild = async function runAfterBuild() {
    if (!resolved || afterBuildRan) {
      return;
    }
    afterBuildRan = true;
    if (oxidePlugins.length === 0 && resolved.plugins.length > 0) {
      await loadPlugins();
    }
    copyPublicDir(resolved);
    await runOxidePluginHook(
      oxidePlugins,
      "afterBuild",
      toOxideBuildContext(resolved)
    );
    maybePrepareCelldDeploy(resolved.outDir);
  };

  const maybePrepareOnSsrClose = function maybePrepareOnSsrClose(
    environmentName: string | undefined
  ) {
    if (!resolved) {
      return;
    }
    // Cloudflare Vite writes `dist/ssr/wrangler.json` when the ssr env closes.
    // Client can finish first; do not wait for afterBuild to see the snapshot.
    if (environmentName === "ssr" || environmentName === "server") {
      maybePrepareCelldDeploy(resolved.outDir);
    }
  };

  return {
    async buildStart() {
      if (buildHost === "rsbuild" || !viteProductionBuild) {
        return;
      }
      // SAFETY: Vite plugin context — watchMode skips serve / rebuild noise.
      const watchMode = Boolean(
        (this as { meta?: { watchMode?: boolean } }).meta?.watchMode
      );
      if (watchMode) {
        return;
      }
      await runBeforeBuild();
    },
    async closeBundle() {
      if (buildHost === "rsbuild" || !viteProductionBuild || !resolved) {
        return;
      }
      // SAFETY: Vite Environment API — each env closes separately; run once on last.
      const environmentName = (this as { environment?: { name?: string } })
        .environment?.name;
      maybePrepareOnSsrClose(environmentName);
      if (!shouldRunAfterBuild(environmentName, resolved.hasClient)) {
        return;
      }
      await runAfterBuild();
    },
    enforce: "pre",
    load(id, extra?: { ssr?: boolean }) {
      // SAFETY: unplugin binds `this` to the plugin context with addWatchFile / environment / getNativeBuildContext.
      return loadPluginModule(
        this as PluginHookContext,
        id,
        resolved,
        options,
        extra
      );
    },
    name: "oxidejs",
    resolveId(id) {
      if (id === VIRTUAL_ACTIONS_ID) {
        return RESOLVED_VIRTUAL_ACTIONS_ID;
      }
      if (id === VIRTUAL_WORKER_ID) {
        return RESOLVED_VIRTUAL_WORKER_ID;
      }
      if (id === VIRTUAL_CLIENT_ID) {
        return RESOLVED_VIRTUAL_CLIENT_ID;
      }
      if (id === VIRTUAL_WORKFLOWS_ID) {
        return RESOLVED_VIRTUAL_WORKFLOWS_ID;
      }
      if (id === VIRTUAL_QUEUES_ID) {
        return RESOLVED_VIRTUAL_QUEUES_ID;
      }
      if (id === VIRTUAL_SCHEDULES_ID) {
        return RESOLVED_VIRTUAL_SCHEDULES_ID;
      }
      return null;
    },
    rsbuild: {
      setup(api: RsbuildPluginApi) {
        buildHost = "rsbuild";
        api.modifyRsbuildConfig((config) => {
          const root = isString(config.root) ? config.root : process.cwd();
          // SAFETY: RsbuildUserConfig is only probed for html entry paths (environments/build input).
          resolved = resolveOptions(options, root, config as never);
          applyRsbuildEnvironments(config, resolved);
        });
        api.onBeforeBuild?.(async () => {
          beforeBuildRan = false;
          afterBuildRan = false;
          resolved ??= resolveOptions(options, process.cwd());
          await runBeforeBuild();
        });
        api.onAfterBuild?.(async () => {
          await runAfterBuild();
        });
        api.onBeforeStartDevServer(({ server }) => {
          const loadRouter = () => {
            const root = resolved?.root ?? process.cwd();
            return loadActions(root);
          };
          const opts = resolved;
          if (!opts) {
            return;
          }
          if (opts.actions === "ws") {
            attachActionUpgrade(
              server.httpServer,
              loadRouter,
              loadRpcModule,
              opts.actionPath,
              opts.actionSameOrigin
            );
          } else {
            server.middlewares.use(
              actionMiddleware(
                loadRouter,
                loadRpcModule,
                opts.actionPath,
                opts.actionSameOrigin,
                opts.bodyLimit
              )
            );
          }
          if (opts.actionOpenRpc) {
            server.middlewares.use(
              openRpcMiddleware(loadRouter, opts.actionPath, opts.bodyLimit)
            );
          }
        });
        api.onBeforeStartPreviewServer?.(({ server }) => {
          if (resolved === undefined || resolved.preset === "worker") {
            return;
          }
          server.middlewares.use(
            previewMiddleware(path.join(resolved.outDir, "server.js"))
          );
        });
      },
    },
    transform(code, id, extra?: { ssr?: boolean }) {
      // SAFETY: unplugin binds `this` to the plugin context used by pluginShouldStub.
      const ctx = this as PluginHookContext;
      if (
        !isServerFileId(id) ||
        !pluginShouldStub(ctx, extra) ||
        code.startsWith("// oxidejs:client-stub\n")
      ) {
        return;
      }
      return generateClientStub({
        exports: parseExportedNames(code),
        key: moduleKey(id.split("?")[0] ?? id),
        queues: parseQueueExports(code),
        schedules: parseScheduleExports(code),
        streams: parseStreamExports(code),
        workflows: parseWorkflowExports(code),
      });
    },
    vite: {
      config(config, env) {
        buildHost = "vite";
        viteProductionBuild = env?.command === "build";
        beforeBuildRan = false;
        afterBuildRan = false;
        const root = isString(config.root) ? config.root : process.cwd();
        resolved = resolveOptions(options, root, config);
        // SAFETY: Vite UserConfig is passed through for the fields applyViteEnvironments reads (root, environments, build).
        applyViteEnvironments(config as never, resolved);
      },
      configurePreviewServer(server) {
        if (resolved === undefined || resolved.preset === "worker") {
          return;
        }
        server.middlewares.use(
          previewMiddleware(path.join(resolved.outDir, "server.js"))
        );
      },
      configureServer(server) {
        // `@cloudflare/vite-plugin` runs the Worker in workerd; skip Node action middleware.
        if (resolved?.preset === "worker") {
          return;
        }
        const invalidateActions = () => {
          for (const env of Object.values(server.environments)) {
            const mod = env.moduleGraph.getModuleById(
              RESOLVED_VIRTUAL_ACTIONS_ID
            );
            if (mod) {
              void env.moduleGraph.invalidateModule(mod);
            }
          }
        };
        const fetchRouter = async () => {
          // SAFETY: virtual:oxide/actions SSR module exports RpcGroup default + actionsHandlers.
          const mod = (await server.ssrLoadModule(VIRTUAL_ACTIONS_ID)) as {
            actionsHandlers: unknown;
            actionsOpenRpcEntries?: OpenRpcActionEntry[];
            default: unknown;
          };
          return mod;
        };
        // Lazy + clear-on-reject: never leave a rejected promise cached (sticky 503)
        // and never start a follow-up fetch nobody awaits (uncaught rejection → crash).
        let routerReady:
          | Promise<{
              actionsHandlers: unknown;
              actionsOpenRpcEntries?: OpenRpcActionEntry[];
              default: unknown;
            }>
          | undefined;
        const loadRouter = async () => {
          if (routerReady === undefined) {
            routerReady = fetchRouter();
          }
          const current = routerReady;
          try {
            return await current;
          } catch (error) {
            if (routerReady === current) {
              routerReady = undefined;
            }
            throw error;
          }
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
        const loadRpc = () =>
          // SAFETY: oxidejs/rpc SSR module exports createActionHandler + createWsHooks.
          server.ssrLoadModule("oxidejs/rpc") as Promise<RpcDevModule>;
        const logActionError = (error: Error) => {
          server.config.logger.error(
            `oxidejs: action handler failed: ${String(error)}`
          );
        };
        const opts = resolved;
        const wireActions = () => {
          if (!opts) {
            return;
          }
          server.middlewares.use(
            actionMiddleware(
              loadRouter,
              loadRpc,
              opts.actionPath,
              opts.actionSameOrigin,
              opts.bodyLimit,
              logActionError
            )
          );
        };

        if (opts?.actions === "ws") {
          attachActionUpgrade(
            server.httpServer,
            loadRouter,
            loadRpc,
            opts.actionPath,
            opts.actionSameOrigin
          );
        }

        // Register both the production-middleware bridge and /__oxide/action
        // synchronously so they land before Vite's HTML fallback. Loading the
        // middleware modules is async; the bridge awaits that on first use.
        // Deferring `middlewares.use` until after `ssrLoadModule` used to put
        // actions behind Vite's catch-all → empty 404 on POST /__oxide/action.
        const handlersPromise = opts
          ? attachDevMiddlewareBridge(
              // SAFETY: ViteDevServer exposes ssrLoadModule, logger, and Connect middlewares.
              server as never,
              opts
            )
          : Promise.resolve([]);

        if (opts?.actionOpenRpc) {
          server.middlewares.use(
            openRpcMiddleware(loadRouter, opts.actionPath, opts.bodyLimit)
          );
        }

        if (opts?.actions !== "ws") {
          wireActions();
        }

        // Prewarm the SSR action router (and production middleware imports)
        // before Vite prints "ready", so the first client hydration RPC does
        // not race a cold `ssrLoadModule("virtual:oxide/actions")`.
        return async () => {
          try {
            await loadRouter();
            await handlersPromise;
          } catch (error) {
            server.config.logger.error(
              `oxidejs: failed to prewarm dev server: ${String(error)}`
            );
          }
        };
      },
    },
  };
};

export const oxidejs =
  /* @__PURE__ */
  createUnplugin(unpluginFactory);

export const vite =
  /* @__PURE__ */
  (() => oxidejs.vite)();

export default oxidejs;
