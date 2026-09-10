import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertContained,
  copyPublicDir,
  hasWranglerConfig,
  mergeDurableBindings,
  resolveOptions,
} from "./core";
import type { DurableWranglerConfig } from "./core";

const makeTempRoot = function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oxidejs-"));
};

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("resolveOptions", () => {
  test("defaults to fetch when no wrangler config", () => {
    const root = makeTempRoot();
    temps.push(root);
    const resolved = resolveOptions({}, root);
    expect(resolved.preset).toBe("fetch");
    expect(hasWranglerConfig(root)).toBe(false);
    expect(resolved.workerEntry).toBe("src/server.ts");
    expect(resolved.outDir).toBe(path.resolve(root, "dist"));
    expect(resolved.clientDir).toBe("client");
    expect(resolved.workerEntryAbs).toBe(path.resolve(root, "src/server.ts"));
    expect(resolved.hasWorkerEntry).toBe(false);
    expect(resolved.hasClient).toBe(false);
    expect(resolved.hasPublic).toBe(false);
    expect(resolved.actions).toBe("http");
    expect(resolved.actionPath).toBe("/__oxide/action");
    expect(resolved.actionSameOrigin).toBe(true);
  });

  test("defaults to worker when wrangler.jsonc exists", () => {
    const root = makeTempRoot();
    temps.push(root);
    fs.writeFileSync(path.join(root, "wrangler.jsonc"), "{}\n");
    expect(resolveOptions({}, root).preset).toBe("worker");
  });

  test("defaults to worker when wrangler.toml exists", () => {
    const root = makeTempRoot();
    temps.push(root);
    fs.writeFileSync(path.join(root, "wrangler.toml"), 'name = "x"\n');
    expect(resolveOptions({}, root).preset).toBe("worker");
  });

  test("manual preset overrides wrangler detection", () => {
    const withWrangler = makeTempRoot();
    const bare = makeTempRoot();
    temps.push(withWrangler, bare);
    fs.writeFileSync(path.join(withWrangler, "wrangler.jsonc"), "{}\n");
    expect(resolveOptions({ preset: "fetch" }, withWrangler).preset).toBe(
      "fetch"
    );
    expect(resolveOptions({ preset: "worker" }, bare).preset).toBe("worker");
  });

  test("rejects unknown preset", () => {
    expect(() =>
      // SAFETY: intentional invalid preset to assert runtime rejection.
      resolveOptions({ preset: "celld" as never }, process.cwd())
    ).toThrow('unknown preset "celld"');
  });

  test("resolves custom action path and explicit cross-origin opt-out", () => {
    const resolved = resolveOptions(
      { actions: { path: "/rpc", sameOrigin: false } },
      process.cwd()
    );
    expect(resolved.actionPath).toBe("/rpc");
    expect(resolved.actionSameOrigin).toBe(false);
  });

  test("rejects actions.path with a query string", () => {
    expect(() =>
      resolveOptions({ actions: { path: "rpc?bad" } }, process.cwd())
    ).toThrow("actions.path must start with");
  });

  test("detects public/", () => {
    const root = makeTempRoot();
    temps.push(root);
    fs.mkdirSync(path.join(root, "public"));
    expect(resolveOptions({}, root).hasPublic).toBe(true);
  });

  test("detects default worker entry when present", () => {
    const root = makeTempRoot();
    temps.push(root);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/server.ts"), "export default {}");
    expect(resolveOptions({}, root).hasWorkerEntry).toBe(true);
  });

  test("rejects an explicit workerEntry that does not exist", () => {
    const root = makeTempRoot();
    temps.push(root);
    expect(() =>
      resolveOptions({ workerEntry: "src/missing.ts" }, root)
    ).toThrow("workerEntry");
  });

  test("resolves relative middleware paths against project root", () => {
    const root = makeTempRoot();
    temps.push(root);
    const resolved = resolveOptions(
      { middleware: ["./src/mw.ts", "pkg/mw"] },
      root
    );
    expect(resolved.middleware).toEqual([
      path.resolve(root, "src/mw.ts"),
      "pkg/mw",
    ]);
  });

  test("rejects unknown actions transport", () => {
    // SAFETY: intentional invalid transport string to assert runtime rejection.
    expect(() =>
      resolveOptions({ actions: "ftp" as never }, process.cwd())
    ).toThrow("unknown actions transport");
  });

  test("allows actions ws with preset worker", () => {
    expect(
      resolveOptions({ actions: "ws", preset: "worker" }, process.cwd()).actions
    ).toBe("ws");
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
      resolveOptions({}, root, {
        build: { rollupOptions: { input: "app.html" } },
      }).hasClient
    ).toBe(true);
    expect(resolveOptions({}, root).hasClient).toBe(false);
  });

  test("ignores non-html vite input even if index.html exists", () => {
    const root = makeTempRoot();
    temps.push(root);
    fs.writeFileSync(path.join(root, "index.html"), "<html></html>");
    expect(
      resolveOptions({}, root, {
        build: { rollupOptions: { input: "src/main.ts" } },
      }).hasClient
    ).toBe(false);
  });

  test("rejects clientDir that escapes outDir", () => {
    const root = makeTempRoot();
    temps.push(root);
    fs.writeFileSync(path.join(root, "index.html"), "<html></html>");
    expect(() => resolveOptions({ clientDir: "../escape" }, root)).toThrow(
      "clientDir must resolve inside outDir"
    );
  });
});

describe("mergeDurableBindings", () => {
  test("merges scanned workflows queues and crons", () => {
    const root = makeTempRoot();
    temps.push(root);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src/demo.server.ts"),
      `
import { queue, schedule, workflow } from "oxidejs";
export const demo = workflow({
  name: "demo",
  run: async () => {},
});
export const demos = queue({ name: "demos", workflow: demo });
export const hourly = schedule({ name: "demo-hourly", cron: "0 * * * *", workflow: demo });
`
    );
    const config: DurableWranglerConfig = {};
    mergeDurableBindings(config, root);
    expect(config.workflows).toEqual([
      { binding: "DEMO", class_name: "DemoWorkflow", name: "demo" },
    ]);
    expect(config.queues?.producers).toEqual([
      { binding: "DEMOS", queue: "demos" },
    ]);
    expect(config.queues?.consumers).toEqual([{ queue: "demos" }]);
    expect(config.triggers?.crons).toEqual(["0 * * * *"]);
  });
});

describe("copyPublicDir", () => {
  test("copies public/ next to client assets on fetch", () => {
    const root = makeTempRoot();
    temps.push(root);
    fs.mkdirSync(path.join(root, "public"), { recursive: true });
    fs.writeFileSync(path.join(root, "public/a.txt"), "a");
    const resolved = resolveOptions({ preset: "fetch" }, root);
    fs.mkdirSync(path.join(resolved.outDir, resolved.clientDir), {
      recursive: true,
    });
    copyPublicDir(resolved);
    expect(
      fs.readFileSync(
        path.join(resolved.outDir, resolved.clientDir, "a.txt"),
        "utf-8"
      )
    ).toBe("a");
  });

  test("skips public/ on worker", () => {
    const root = makeTempRoot();
    temps.push(root);
    fs.mkdirSync(path.join(root, "public"), { recursive: true });
    fs.writeFileSync(path.join(root, "public/a.txt"), "a");
    const resolved = resolveOptions({ preset: "worker" }, root);
    fs.mkdirSync(path.join(resolved.outDir, resolved.clientDir), {
      recursive: true,
    });
    copyPublicDir(resolved);
    expect(
      fs.existsSync(path.join(resolved.outDir, resolved.clientDir, "a.txt"))
    ).toBe(false);
  });
});

describe("assertContained", () => {
  test("rejects paths that escape outDir", () => {
    const root = makeTempRoot();
    temps.push(root);
    expect(() =>
      assertContained(root, path.join(root, "..", "outside"), "x")
    ).toThrow("must resolve inside outDir");
    fs.writeFileSync(path.join(root, "index.html"), "<html></html>");
    expect(() => resolveOptions({ clientDir: "../outside" }, root)).toThrow(
      "clientDir must resolve inside outDir"
    );
    expect(() => resolveOptions({ clientDir: "/tmp" }, root)).toThrow(
      "clientDir must resolve inside outDir"
    );
  });
});
