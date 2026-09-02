import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyPublicDir, createEmitState, resolveOptions, tryEmitWranglerConfig } from "./core";

const wrangler = { name: "vite-cf", compatibility_date: "2026-01-01" };

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oxidejs-"));
}

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveOptions", () => {
  test("applies fetch defaults", () => {
    const root = makeTempRoot();
    temps.push(root);
    const resolved = resolveOptions({}, root);
    expect(resolved.preset).toBe("fetch");
    expect(resolved.workerEntry).toBe("src/server.ts");
    expect(resolved.outDir).toBe(path.resolve(root, "dist"));
    expect(resolved.clientDir).toBe("client");
    expect(resolved.emitConfig).toBe(false);
    expect(resolved.workerEntryAbs).toBe(path.resolve(root, "src/server.ts"));
    expect(resolved.hasClient).toBe(false);
    expect(resolved.hasPublic).toBe(false);
    expect(resolved.actions).toBe("http");
    expect(resolved.actionPath).toBe("/__oxide/action");
    expect(resolved.actionSameOrigin).toBe(true);
  });

  test("resolves custom action path and explicit cross-origin opt-out", () => {
    const resolved = resolveOptions(
      { actions: { path: "/rpc", sameOrigin: false } },
      process.cwd(),
    );
    expect(resolved.actionPath).toBe("/rpc");
    expect(resolved.actionSameOrigin).toBe(false);
    expect(() => resolveOptions({ actions: { path: "rpc?bad" } }, process.cwd())).toThrow(
      "actions.path",
    );
  });

  test("detects public/", () => {
    const root = makeTempRoot();
    temps.push(root);
    fs.mkdirSync(path.join(root, "public"));
    expect(resolveOptions({}, root).hasPublic).toBe(true);
  });

  test("rejects unknown actions transport and ws+celld", () => {
    expect(() => resolveOptions({ actions: "ftp" as never }, process.cwd())).toThrow(
      "unknown actions transport",
    );
    expect(() =>
      resolveOptions({ preset: "celld", actions: "ws", wrangler }, process.cwd()),
    ).toThrow('actions: "ws" is not supported with preset: "celld"');
  });

  test("detects client when index.html exists", () => {
    const root = makeTempRoot();
    temps.push(root);
    fs.writeFileSync(path.join(root, "index.html"), "<html></html>");
    expect(resolveOptions({}, root).hasClient).toBe(true);
  });

  test("detects html from vite rollupOptions.input", () => {
    const root = makeTempRoot();
    temps.push(root);
    fs.writeFileSync(path.join(root, "app.html"), "<html></html>");
    expect(
      resolveOptions({}, root, { build: { rollupOptions: { input: "app.html" } } }).hasClient,
    ).toBe(true);
    expect(resolveOptions({}, root).hasClient).toBe(false);
  });

  test("ignores non-html vite input even if index.html exists", () => {
    const root = makeTempRoot();
    temps.push(root);
    fs.writeFileSync(path.join(root, "index.html"), "<html></html>");
    expect(
      resolveOptions({}, root, { build: { rolldownOptions: { input: "src/main.ts" } } }).hasClient,
    ).toBe(false);
  });

  test("celld requires wrangler.name and compatibility_date", () => {
    expect(() => resolveOptions({ preset: "celld" }, process.cwd())).toThrow(
      "wrangler.name and wrangler.compatibility_date are required",
    );
    expect(() =>
      resolveOptions({ preset: "celld", wrangler: { name: "x" } as never }, process.cwd()),
    ).toThrow("wrangler.name and wrangler.compatibility_date are required");
  });

  test("rejects unknown wrangler keys", () => {
    expect(() =>
      resolveOptions(
        { preset: "celld", wrangler: { ...wrangler, kv_namespaces: [] } as never },
        process.cwd(),
      ),
    ).toThrow("not supported by celld deploy: kv_namespaces");
  });

  test("rejects user-supplied main and assets", () => {
    expect(() =>
      resolveOptions(
        { preset: "celld", wrangler: { ...wrangler, main: "./nope.js" } as never },
        process.cwd(),
      ),
    ).toThrow("computed by the plugin");
    expect(() =>
      resolveOptions(
        {
          preset: "celld",
          wrangler: { ...wrangler, assets: { directory: "./nope" } } as never,
        },
        process.cwd(),
      ),
    ).toThrow("computed by the plugin");
  });

  test("rejects clientDir that escapes outDir", () => {
    const root = makeTempRoot();
    temps.push(root);
    fs.writeFileSync(path.join(root, "index.html"), "<html></html>");
    expect(() => resolveOptions({ clientDir: "../escape" }, root)).toThrow(
      "clientDir must resolve inside outDir",
    );
  });

  test("skips required wrangler fields on fetch", () => {
    const resolved = resolveOptions({ preset: "fetch" }, process.cwd());
    expect(resolved.emitConfig).toBe(false);
    expect(resolved.wrangler).toBeUndefined();
  });
});

describe("tryEmitWranglerConfig", () => {
  test("no-ops if server.js is missing", () => {
    const root = makeTempRoot();
    temps.push(root);
    const resolved = resolveOptions({ preset: "celld", wrangler }, root);
    fs.mkdirSync(resolved.outDir, { recursive: true });
    tryEmitWranglerConfig(resolved, createEmitState());
    expect(fs.existsSync(path.join(resolved.outDir, "wrangler.jsonc"))).toBe(false);
  });

  test("no-ops if client dir is missing when index.html exists", () => {
    const root = makeTempRoot();
    temps.push(root);
    fs.writeFileSync(path.join(root, "index.html"), "<html></html>");
    const resolved = resolveOptions({ preset: "celld", wrangler }, root);
    fs.mkdirSync(resolved.outDir, { recursive: true });
    fs.writeFileSync(path.join(resolved.outDir, "server.js"), "export {}");
    tryEmitWranglerConfig(resolved, createEmitState());
    expect(fs.existsSync(path.join(resolved.outDir, "wrangler.jsonc"))).toBe(false);
  });

  test("writes wrangler.jsonc without assets when there is no index.html", () => {
    const root = makeTempRoot();
    temps.push(root);
    const resolved = resolveOptions({ preset: "celld", wrangler }, root);
    fs.mkdirSync(resolved.outDir, { recursive: true });
    fs.writeFileSync(path.join(resolved.outDir, "server.js"), "export {}");
    tryEmitWranglerConfig(resolved, createEmitState());
    expect(
      JSON.parse(fs.readFileSync(path.join(resolved.outDir, "wrangler.jsonc"), "utf8")),
    ).toEqual({
      name: "vite-cf",
      main: "./server.js",
      compatibility_date: "2026-01-01",
      compatibility_flags: ["nodejs_compat"],
    });
  });

  test("writes wrangler.jsonc once when both outputs exist", () => {
    const root = makeTempRoot();
    temps.push(root);
    fs.writeFileSync(path.join(root, "index.html"), "<html></html>");
    const resolved = resolveOptions(
      {
        preset: "celld",
        wrangler: {
          ...wrangler,
          compatibility_flags: ["nodejs_compat"],
          vars: { FOO: "bar" },
        },
      },
      root,
    );
    fs.mkdirSync(path.join(resolved.outDir, resolved.clientDir), {
      recursive: true,
    });
    fs.writeFileSync(path.join(resolved.outDir, "server.js"), "export {}");

    const state = createEmitState();
    tryEmitWranglerConfig(resolved, state);
    tryEmitWranglerConfig(resolved, state);

    const file = path.join(resolved.outDir, "wrangler.jsonc");
    const first = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(first) as Record<string, unknown>;
    expect(parsed).toEqual({
      name: "vite-cf",
      main: "./server.js",
      compatibility_date: "2026-01-01",
      compatibility_flags: ["nodejs_compat"],
      vars: { FOO: "bar" },
      assets: { directory: "./client", binding: "ASSETS" },
    });
    expect(state.emitted).toBe(true);

    fs.writeFileSync(file, "changed");
    tryEmitWranglerConfig(resolved, state);
    expect(fs.readFileSync(file, "utf8")).toBe("changed");
  });

  test("fetch never writes wrangler.jsonc", () => {
    const root = makeTempRoot();
    temps.push(root);
    const resolved = resolveOptions({ preset: "fetch" }, root);
    fs.mkdirSync(path.join(resolved.outDir, resolved.clientDir), {
      recursive: true,
    });
    fs.writeFileSync(path.join(resolved.outDir, "server.js"), "export {}");
    tryEmitWranglerConfig(resolved, createEmitState());
    expect(fs.existsSync(path.join(resolved.outDir, "wrangler.jsonc"))).toBe(false);
  });
});

describe("copyPublicDir", () => {
  test("copies public/ next to client assets", () => {
    const root = makeTempRoot();
    temps.push(root);
    fs.mkdirSync(path.join(root, "public"), { recursive: true });
    fs.writeFileSync(path.join(root, "public", "favicon.ico"), "ico");
    const resolved = resolveOptions({}, root);
    copyPublicDir(resolved);
    expect(fs.readFileSync(path.join(resolved.outDir, "client", "favicon.ico"), "utf8")).toBe(
      "ico",
    );
  });

  test("skips public/ on celld", () => {
    const root = makeTempRoot();
    temps.push(root);
    fs.mkdirSync(path.join(root, "public"), { recursive: true });
    fs.writeFileSync(path.join(root, "public", "favicon.ico"), "ico");
    copyPublicDir(resolveOptions({ preset: "celld", wrangler }, root));
    expect(fs.existsSync(path.join(root, "dist", "client", "favicon.ico"))).toBe(false);
  });
});

describe("assertContained", () => {
  test("rejects paths that escape outDir", () => {
    const root = makeTempRoot();
    temps.push(root);
    const out = path.join(root, "dist");
    fs.mkdirSync(out, { recursive: true });
    expect(() => resolveOptions({ clientDir: "../outside" }, root)).not.toThrow();
    fs.writeFileSync(path.join(root, "index.html"), "<html></html>");
    expect(() => resolveOptions({ clientDir: "../outside" }, root)).toThrow(
      "clientDir must resolve inside outDir",
    );
    expect(() => resolveOptions({ clientDir: "/tmp" }, root)).toThrow(
      "clientDir must resolve inside outDir",
    );
  });
});
