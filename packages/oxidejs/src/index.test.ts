import { describe, expect, test } from "bun:test";
import { VIRTUAL_WORKER_ID } from "./actions";
import { pluginOxidejs } from "./rsbuild";
import { oxidejs, unpluginFactory, vite } from "./index";
import { applyViteEnvironments } from "./worker-build";
import { resolveOptions } from "./core";

const wrangler = { name: "vite-cf", compatibility_date: "2026-01-01" };

describe("factory shape", () => {
  test("exposes vite adapter", () => {
    expect(typeof oxidejs.vite).toBe("function");
    expect(typeof vite).toBe("function");
    expect(typeof unpluginFactory).toBe("function");
  });

  test("fetch preset writes dist/server.js for node", () => {
    const resolved = resolveOptions({}, "/tmp/project");
    const config = applyViteEnvironments({}, resolved);
    expect(config.builder).toEqual({});
    expect(config.environments?.["client"]?.consumer).toBe("client");
    expect(config.environments?.["client"]?.build?.outDir).toBe(
      pathJoin(resolved.outDir, "client"),
    );
    expect(config.environments?.["server"]?.build?.outDir).toBe(resolved.outDir);
    expect(config.environments?.["server"]?.build?.rollupOptions?.input).toBe(VIRTUAL_WORKER_ID);
    expect(config.environments?.["server"]?.build?.rollupOptions?.output?.entryFileNames).toBe(
      "server.js",
    );
    expect(config.environments?.["server"]?.resolve).toEqual({ noExternal: true });
    expect(config.environments?.["server"]?.ssr).toEqual({ noExternal: true });
    expect(config.build?.outDir).toBe(pathJoin(resolved.outDir, "client"));
    expect(config.build?.manifest).toBe(true);
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
});

describe("rsbuild plugin", () => {
  test("is a native plugin, not an unplugin adapter", () => {
    const plugin = pluginOxidejs();
    expect(plugin.name).toBe("oxidejs");
    expect(typeof plugin.setup).toBe("function");
  });
});

function pathJoin(a: string, b: string): string {
  return `${a.replace(/\/$/, "")}/${b}`;
}
