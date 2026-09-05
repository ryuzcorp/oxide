import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RESOLVED_VIRTUAL_ACTIONS_ID, VIRTUAL_WORKER_ID } from "./actions";
import { resolveOptions } from "./core";
import { oxidejs, unpluginFactory, vite } from "./plugin";
import rsbuild from "./rsbuild";
import {
  applyRsbuildEnvironments,
  applyViteEnvironments,
} from "./worker-build";

const wrangler = { compatibility_date: "2026-01-01", name: "vite-cf" };

interface DevContext {
  ctx?: undefined;
  env: { mode: string };
}

interface NodeReq {
  emit: (event: string, ...args: unknown[]) => boolean;
  headers: { host: string };
  method: string;
  url: string;
}

type ConnectResponse = Record<string, never>;

interface ViteDevServerMock {
  config: { logger: { error: (message?: string) => void } };
  environments: Record<string, never>;
  middlewares: { use: (handler: ConnectHandler) => void };
  ssrLoadModule: () => Promise<{
    default: AppHandler | { ping: () => string };
  }>;
  watcher: { on: () => void };
}

interface LoadThis {
  addWatchFile: () => void;
  environment: { config: { consumer: string } };
}

type AppHandler = (request: Request, context: DevContext) => undefined;
type ViteConfigHook = (config: { root: string }) => undefined;
type ConnectHandler = (
  req: NodeReq,
  res: ConnectResponse,
  next: () => undefined
) => undefined;
type ConfigurePostHook = () => undefined | Promise<undefined>;
type ConfigureServerHook = (
  server: ViteDevServerMock
) => ConfigurePostHook | undefined;
type PluginLoad = (this: LoadThis, id: string) => string | undefined;
type PluginTransform = (
  this: LoadThis,
  code: string,
  id: string
) => string | undefined;
type ViteEnvConfig = ReturnType<typeof applyViteEnvironments>;
type ResolvedOpts = ReturnType<typeof resolveOptions>;

const rootWithHtml = function rootWithHtml(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxidejs-"));
  fs.writeFileSync(path.join(root, "index.html"), "<html></html>");
  return root;
};

const expectSinglePlugin = function expectSinglePlugin(
  plugin: ReturnType<typeof unpluginFactory>
) {
  if (Array.isArray(plugin)) {
    throw new TypeError("expected a single plugin");
  }
  return plugin;
};

/** Build the vite-shaped unplugin for unit tests. */
const vitePlugin = function vitePlugin(
  opts: Parameters<typeof unpluginFactory>[0] = {}
) {
  // SAFETY: unplugin meta is framework-tagged; tests only need the vite branch.
  return expectSinglePlugin(
    unpluginFactory(opts, { framework: "vite" } as never)
  );
};

const invokeConnect = async function invokeConnect(
  handler: ConnectHandler,
  req: NodeReq
) {
  const { promise, resolve } = Promise.withResolvers<null>();
  handler(req, {}, () => {
    resolve(null);
  });
  await promise;
};

const expectClientEnv = function expectClientEnv(
  config: ViteEnvConfig,
  resolved: ResolvedOpts
) {
  expect(config.environments?.["client"]?.consumer).toBe("client");
  expect(config.environments?.["client"]?.build?.outDir).toBe(
    path.join(resolved.outDir, "client")
  );
};

const expectSsrBuild = function expectSsrBuild(
  config: ViteEnvConfig,
  resolved: ResolvedOpts
) {
  expect(config.environments?.["ssr"]?.consumer).toBe("server");
  expect(config.environments?.["ssr"]?.build?.ssr).toBe(true);
  expect(config.environments?.["ssr"]?.build?.outDir).toBe(resolved.outDir);
  expect(config.environments?.["ssr"]?.build?.emptyOutDir).toBe(false);
};

const expectSsrBundle = function expectSsrBundle(config: ViteEnvConfig) {
  expect(config.environments?.["ssr"]?.build?.rollupOptions?.input).toBe(
    VIRTUAL_WORKER_ID
  );
  expect(
    config.environments?.["ssr"]?.build?.rollupOptions?.output?.entryFileNames
  ).toBe("server.js");
  expect(config.environments?.["ssr"]?.resolve).toEqual({
    noExternal: ["effect", "oxidejs"],
  });
  expect(config.environments?.["ssr"]?.ssr).toEqual({
    noExternal: ["effect", "oxidejs"],
  });
};

const expectViteDeps = function expectViteDeps(
  config: ViteEnvConfig,
  resolved: ResolvedOpts
) {
  expect(config.builder).toEqual({});
  expect(config.resolve?.dedupe).toEqual(["effect", "oxidejs"]);
  expect(config.optimizeDeps?.include).toEqual([
    "effect",
    "effect/unstable/rpc",
    "effect/unstable/http",
    "effect/unstable/socket",
    "oxidejs",
    "oxidejs/rpc/client",
  ]);
  expect(config.build?.outDir).toBe(path.join(resolved.outDir, "client"));
  expect(config.build?.manifest).toBe(true);
};

const expectFetchViteLayout = function expectFetchViteLayout(
  config: ViteEnvConfig,
  resolved: ResolvedOpts
) {
  expectClientEnv(config, resolved);
  expectSsrBuild(config, resolved);
  expectSsrBundle(config);
  expectViteDeps(config, resolved);
};

describe("factory shape", () => {
  test("exposes vite and rsbuild adapters from the same factory", () => {
    expect(oxidejs.vite).toBeInstanceOf(Function);
    expect(vite).toBeInstanceOf(Function);
    expect(oxidejs.rsbuild).toBeInstanceOf(Function);
    expect(rsbuild).toBeInstanceOf(Function);
    expect(unpluginFactory).toBeInstanceOf(Function);
  });

  test("shared hooks include transform; both adapters wire config and /__oxide/action", () => {
    const plugin = vitePlugin();
    expect(plugin.name).toBe("oxidejs");
    expect(plugin.enforce).toBe("pre");
    expect(plugin.resolveId).toBeInstanceOf(Function);
    expect(plugin.load).toBeInstanceOf(Function);
    expect(plugin.transform).toBeInstanceOf(Function);
    expect(plugin.writeBundle).toBeInstanceOf(Function);
    expect(plugin.vite?.config).toBeInstanceOf(Function);
    expect(plugin.vite?.configureServer).toBeInstanceOf(Function);
    expect(plugin.vite?.configurePreviewServer).toBeInstanceOf(Function);
    expect(plugin.rsbuild?.setup).toBeInstanceOf(Function);
  });

  test("vite registers middleware and actions synchronously before Vite internals", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-dev-"));
    const seen: DevContext[] = [];
    const plugin = vitePlugin({
      env: { mode: "dev" },
      middleware: ["./middleware"],
    });
    if (!plugin.vite) {
      throw new Error("expected vite hooks");
    }
    // SAFETY: vite.config accepts a partial UserConfig in this harness.
    (plugin.vite.config as ViteConfigHook)({ root });

    const handlers: ConnectHandler[] = [];
    const server: ViteDevServerMock = {
      config: { logger: { error() {} } },
      environments: {},
      middlewares: {
        use: (handler: ConnectHandler) => {
          handlers.push(handler);
        },
      },
      ssrLoadModule: () =>
        Promise.resolve({
          default: ((_request: Request, context: DevContext) => {
            seen.push(context);
          }) satisfies AppHandler,
        }),
      watcher: { on() {} },
    };

    try {
      // SAFETY: configureServer is invoked with a ViteDevServer-shaped mock.
      const configureServer: ConfigureServerHook = plugin.vite
        .configureServer as never;
      const post = configureServer(server);
      expect(handlers).toHaveLength(2);
      expect(post).toBeInstanceOf(Function);
      // Downstream framework middleware.
      handlers.push((_req, _res, next) => {
        next();
      });
      const { EventEmitter } = await import("node:events");
      // oxlint-disable-next-line unicorn/prefer-event-target -- Connect req uses EventEmitter
      const reqBase = Object.assign(new EventEmitter(), {
        headers: { host: "localhost" },
        method: "GET",
        url: "/other",
      });
      // SAFETY: EventEmitter + method/url/headers matches the Connect request shape.
      const req = reqBase as NodeReq;
      const [first] = handlers;
      if (!first) {
        throw new Error("expected middleware handler");
      }
      await invokeConnect(first, req);
      expect(seen).toEqual([{ ctx: undefined, env: { mode: "dev" } }]);

      // Action path must skip the bridge so the body stays readable for RPC.
      let actionNext = false;
      // oxlint-disable-next-line unicorn/prefer-event-target -- Connect req uses EventEmitter
      const actionBase = Object.assign(new EventEmitter(), {
        headers: { host: "localhost" },
        method: "POST",
        url: "/__oxide/action",
      });
      // SAFETY: EventEmitter + method/url/headers matches the Connect request shape.
      const actionReq = actionBase as NodeReq;
      first(actionReq, {}, () => {
        actionNext = true;
      });
      expect(actionNext).toBe(true);
      expect(seen).toHaveLength(1);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("vite retries a rejected action router on the next load", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-retry-"));
    const plugin = vitePlugin();
    if (!plugin.vite) {
      throw new Error("expected vite hooks");
    }
    // SAFETY: vite.config accepts a partial UserConfig in this harness.
    (plugin.vite.config as ViteConfigHook)({ root });

    let loads = 0;
    const errors: string[] = [];
    const server: ViteDevServerMock = {
      config: {
        logger: {
          error(message = "") {
            errors.push(message);
          },
        },
      },
      environments: {},
      middlewares: { use() {} },
      ssrLoadModule: () => {
        loads += 1;
        if (loads === 1) {
          return Promise.reject(new Error("cold"));
        }
        return Promise.resolve({ default: { ping: () => "ok" } });
      },
      watcher: { on() {} },
    };

    try {
      // SAFETY: configureServer is invoked with a ViteDevServer-shaped mock.
      const configureServer: ConfigureServerHook = plugin.vite
        .configureServer as never;
      const post = configureServer(server);
      if (!post) {
        throw new Error("expected configureServer post hook");
      }
      await post();
      expect(errors.some((message) => message.includes("prewarm"))).toBe(true);
      expect(loads).toBe(1);
      errors.length = 0;
      await post();
      expect(errors).toEqual([]);
      expect(loads).toBe(2);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("client load stubs *.server.tsx and blocks virtual actions", () => {
    const plugin = vitePlugin();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-load-"));
    const file = path.join(root, "secret.server.tsx");
    const source = `import { action, useRequest } from "oxidejs";\nconst SECRET = "leak-me";\nexport const ping = action(async () => <div>{useRequest().url}{SECRET}</div>)\n`;
    fs.writeFileSync(file, source);
    // SAFETY: load is called with a LoadThis-shaped unplugin context.
    const load: PluginLoad = plugin.load as never;
    const ctx: LoadThis = {
      addWatchFile() {},
      environment: { config: { consumer: "client" } },
    };
    try {
      const stub = load.call(ctx, file);
      expect(stub).toBeDefined();
      expect(String(stub)).toContain("virtual:oxide/client");
      expect(String(stub)).not.toContain("leak-me");
      expect(String(load.call(ctx, "\0virtual:oxide/client"))).toContain(
        "oxidejs/rpc/client"
      );
      const wsPlugin = vitePlugin({ actions: "ws" });
      // SAFETY: load is called with a LoadThis-shaped unplugin context.
      const wsLoad: PluginLoad = wsPlugin.load as never;
      expect(String(wsLoad.call(ctx, "\0virtual:oxide/client"))).toContain(
        '"transport":"ws"'
      );
      expect(String(load.call(ctx, RESOLVED_VIRTUAL_ACTIONS_ID))).toContain(
        "RpcGroup.make"
      );
      expect(String(load.call(ctx, RESOLVED_VIRTUAL_ACTIONS_ID))).not.toContain(
        "AsyncLocalStorage"
      );
      const serverCtx: LoadThis = {
        addWatchFile() {},
        environment: { config: { consumer: "server" } },
      };
      expect(load.call(serverCtx, file)).toBeUndefined();
      // SAFETY: transform is called with a LoadThis-shaped unplugin context.
      const transform: PluginTransform = plugin.transform as never;
      expect(transform.call(ctx, String(stub), file)).toBeUndefined();
      const leaked = transform.call(ctx, source, file);
      expect(String(leaked)).not.toContain("leak-me");
      expect(String(leaked)).toContain('client["secret"]["ping"]');
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("fetch preset writes dist/server.js for node", () => {
    const root = rootWithHtml();
    try {
      const resolved = resolveOptions({}, root);
      const config = applyViteEnvironments({}, resolved);
      expectFetchViteLayout(config, resolved);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("no index.html skips the client environment", () => {
    const resolved = resolveOptions(
      {},
      fs.mkdtempSync(path.join(os.tmpdir(), "oxidejs-"))
    );
    const viteConfig = applyViteEnvironments({}, resolved);
    expect(viteConfig.environments?.["client"]).toBeUndefined();
    expect(viteConfig.appType).toBe("custom");
    expect(viteConfig.builder?.buildApp).toBeInstanceOf(Function);
    expect(viteConfig.environments?.["ssr"]?.build?.outDir).toBe(
      resolved.outDir
    );
    expect(viteConfig.environments?.["ssr"]?.build?.emptyOutDir).toBe(true);
    expect(viteConfig.build?.outDir).toBe(resolved.outDir);
    const rsbuildConfig = applyRsbuildEnvironments({}, resolved);
    expect(rsbuildConfig.environments?.["web"]).toBeUndefined();
    expect(rsbuildConfig.environments?.["server"]?.output?.filename).toEqual({
      js: "server.js",
    });
  });

  test("celld preset targets webworker", () => {
    const resolved = resolveOptions(
      { preset: "celld", wrangler },
      "/tmp/project"
    );
    const config = applyViteEnvironments({}, resolved);
    expect(config.environments?.["ssr"]?.resolve).toEqual({
      conditions: ["worker"],
      noExternal: true,
    });
    expect(config.environments?.["ssr"]?.ssr).toEqual({
      external: [/^cloudflare:/u],
      noExternal: true,
      target: "webworker",
    });
  });

  test("rsbuild fetch environments match vite output layout", () => {
    const root = rootWithHtml();
    try {
      const resolved = resolveOptions({}, root);
      const config = applyRsbuildEnvironments({}, resolved);
      expect(config.environments?.["web"]?.output?.distPath?.root).toBe(
        path.join(resolved.outDir, "client")
      );
      expect(config.environments?.["server"]?.source?.entry).toEqual({
        server: { html: false, import: VIRTUAL_WORKER_ID },
      });
      expect(config.environments?.["server"]?.output).toEqual({
        distPath: { root: resolved.outDir },
        filename: { js: "server.js" },
        target: "node",
      });
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("rsbuild celld environment targets web-worker", () => {
    const resolved = resolveOptions(
      { preset: "celld", wrangler },
      "/tmp/project"
    );
    const config = applyRsbuildEnvironments({}, resolved);
    expect(config.environments?.["server"]?.output?.target).toBe("web-worker");
    expect(config.environments?.["server"]?.resolve).toEqual({
      conditionNames: ["worker", "..."],
    });
  });
});
