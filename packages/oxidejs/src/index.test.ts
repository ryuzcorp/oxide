import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RESOLVED_VIRTUAL_ACTIONS_ID, VIRTUAL_ACTIONS_ID, VIRTUAL_WORKER_ID } from "./actions";
import { oxidejs, unpluginFactory, vite } from "./index";
import rsbuild from "./rsbuild";
import { applyRsbuildEnvironments, applyViteEnvironments } from "./worker-build";
import { resolveOptions } from "./core";

const wrangler = { name: "vite-cf", compatibility_date: "2026-01-01" };

function rootWithHtml(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxidejs-"));
  fs.writeFileSync(path.join(root, "index.html"), "<html></html>");
  return root;
}

describe("factory shape", () => {
  test("exposes vite and rsbuild adapters from the same factory", () => {
    expect(typeof oxidejs.vite).toBe("function");
    expect(typeof vite).toBe("function");
    expect(typeof oxidejs.rsbuild).toBe("function");
    expect(typeof rsbuild).toBe("function");
    expect(typeof unpluginFactory).toBe("function");
  });

  test("shared hooks include transform; both adapters wire config and /_action", () => {
    const plugin = unpluginFactory({}, { framework: "vite" } as never);
    if (Array.isArray(plugin)) throw new Error("expected a single plugin");
    expect(plugin.name).toBe("oxidejs");
    expect(plugin.enforce).toBe("pre");
    expect(typeof plugin.resolveId).toBe("function");
    expect(typeof plugin.load).toBe("function");
    expect(typeof plugin.transform).toBe("function");
    expect(typeof plugin.writeBundle).toBe("function");
    expect(typeof plugin.vite?.config).toBe("function");
    expect(typeof plugin.vite?.configureServer).toBe("function");
    expect(typeof plugin.vite?.configurePreviewServer).toBe("function");
    expect(typeof plugin.rsbuild?.setup).toBe("function");
  });

  test("client load stubs *.server.ts and blocks virtual actions", () => {
    const plugin = unpluginFactory({}, { framework: "vite" } as never);
    if (Array.isArray(plugin)) throw new Error("expected a single plugin");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-load-"));
    const file = path.join(root, "secret.server.ts");
    fs.writeFileSync(
      file,
      `const SECRET = "leak-me";\nexport async function ping() { return SECRET }\n`,
    );
    const load = plugin.load as (this: object, id: string) => unknown;
    const ctx = {
      environment: { config: { consumer: "client" } },
      addWatchFile() {},
    };
    try {
      const stub = load.call(ctx, file);
      expect(typeof stub).toBe("string");
      expect(String(stub)).toContain("virtual:oxide/client");
      expect(String(stub)).not.toContain("leak-me");
      expect(String(load.call(ctx, "\0virtual:oxide/client"))).toContain("tacho/client/http");
      const wsPlugin = unpluginFactory({ actions: "ws" }, { framework: "vite" } as never);
      if (Array.isArray(wsPlugin)) throw new Error("expected a single plugin");
      const wsLoad = wsPlugin.load as (this: object, id: string) => unknown;
      expect(String(wsLoad.call(ctx, "\0virtual:oxide/client"))).toContain("tacho/client/ws");
      expect(() => load.call(ctx, RESOLVED_VIRTUAL_ACTIONS_ID)).toThrow(
        `${VIRTUAL_ACTIONS_ID} is server-only`,
      );
      const serverCtx = {
        environment: { config: { consumer: "server" } },
        addWatchFile() {},
      };
      expect(load.call(serverCtx, file)).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("fetch preset writes dist/server.js for node", () => {
    const root = rootWithHtml();
    try {
      const resolved = resolveOptions({}, root);
      const config = applyViteEnvironments({}, resolved);
      expect(config.builder).toEqual({});
      expect(config.environments?.["client"]?.consumer).toBe("client");
      expect(config.environments?.["client"]?.build?.outDir).toBe(
        path.join(resolved.outDir, "client"),
      );
      expect(config.environments?.["server"]?.consumer).toBe("server");
      expect(config.environments?.["server"]?.build?.ssr).toBe(true);
      expect(config.environments?.["server"]?.build?.outDir).toBe(resolved.outDir);
      expect(config.environments?.["server"]?.build?.emptyOutDir).toBe(false);
      expect(config.environments?.["server"]?.build?.rollupOptions?.input).toBe(VIRTUAL_WORKER_ID);
      expect(config.environments?.["server"]?.build?.rollupOptions?.output?.entryFileNames).toBe(
        "server.js",
      );
      expect(config.environments?.["server"]?.resolve).toEqual({ noExternal: true });
      expect(config.environments?.["server"]?.ssr).toEqual({ noExternal: true });
      expect(config.build?.outDir).toBe(path.join(resolved.outDir, "client"));
      expect(config.build?.manifest).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("no index.html skips the client environment", () => {
    const resolved = resolveOptions({}, fs.mkdtempSync(path.join(os.tmpdir(), "oxidejs-")));
    const vite = applyViteEnvironments({}, resolved);
    expect(vite.environments?.["client"]).toBeUndefined();
    expect(vite.appType).toBe("custom");
    expect(typeof vite.builder?.buildApp).toBe("function");
    expect(vite.environments?.["server"]?.build?.outDir).toBe(resolved.outDir);
    expect(vite.environments?.["server"]?.build?.emptyOutDir).toBe(true);
    expect(vite.build?.outDir).toBe(resolved.outDir);
    const rsbuild = applyRsbuildEnvironments({}, resolved);
    expect(rsbuild.environments?.["web"]).toBeUndefined();
    expect(rsbuild.environments?.["server"]?.output?.filename).toEqual({ js: "server.js" });
  });

  test("celld preset targets webworker", () => {
    const resolved = resolveOptions({ preset: "celld", wrangler }, "/tmp/project");
    const config = applyViteEnvironments({}, resolved);
    expect(config.environments?.["server"]?.resolve).toEqual({
      conditions: ["worker"],
      noExternal: true,
    });
    expect(config.environments?.["server"]?.ssr).toEqual({
      target: "webworker",
      noExternal: true,
    });
  });

  test("rsbuild fetch environments match vite output layout", () => {
    const root = rootWithHtml();
    try {
      const resolved = resolveOptions({}, root);
      const config = applyRsbuildEnvironments({}, resolved);
      expect(config.environments?.["web"]?.output?.distPath?.root).toBe(
        path.join(resolved.outDir, "client"),
      );
      expect(config.environments?.["server"]?.source?.entry).toEqual({
        server: { import: VIRTUAL_WORKER_ID, html: false },
      });
      expect(config.environments?.["server"]?.output).toEqual({
        target: "node",
        filename: { js: "server.js" },
        distPath: { root: resolved.outDir },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("rsbuild celld environment targets web-worker", () => {
    const resolved = resolveOptions({ preset: "celld", wrangler }, "/tmp/project");
    const config = applyRsbuildEnvironments({}, resolved);
    expect(config.environments?.["server"]?.output?.target).toBe("web-worker");
    expect(config.environments?.["server"]?.resolve).toEqual({
      conditionNames: ["worker", "..."],
    });
  });
});
