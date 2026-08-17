import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handle } from "tacho/transport/fetch";
import {
  generateActionsModule,
  generateClientStub,
  generateWorkerWrapper,
  parseExportedNames,
  scanServerFiles,
  shouldStubServerModule,
} from "./actions";

describe("parseExportedNames", () => {
  test("finds functions, generators, and consts", () => {
    expect(
      parseExportedNames(`
        export async function ping() { return "pong" }
        export function echo(x: string) { return x }
        export async function* ticks() { yield 0 }
        export const add = async (a: number, b: number) => a + b
      `),
    ).toEqual(["ping", "echo", "ticks", "add"]);
  });
});

describe("scanServerFiles", () => {
  test("keys by filename and rejects collisions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-actions-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "test.server.ts"), "export async function ping() {}\n");
    const mods = scanServerFiles(root);
    expect(mods).toHaveLength(1);
    expect(mods[0]?.key).toBe("test");
    expect(mods[0]?.exports).toEqual(["ping"]);

    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "lib", "test.server.ts"), "export async function ping() {}\n");
    expect(() => scanServerFiles(root)).toThrow('duplicate server module key "test"');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("codegen", () => {
  test("client stub posts through tacho", () => {
    const stub = generateClientStub({ key: "test", exports: ["ping"] });
    expect(stub).toContain('createClient({ url: "/_action" })');
    expect(stub).toContain('__rpc["test"]["ping"](args)');
  });

  test("virtual module keys exports by file", () => {
    const code = generateActionsModule([
      { abs: "/app/src/test.server.ts", key: "test", exports: ["ping"] },
    ]);
    expect(code).toContain('import * as __m0 from "/app/src/test.server.ts"');
    expect(code).toContain('"test": {');
    expect(code).toContain('"ping": rpc.run');
    expect(code).toContain(".apply(null,");
    expect(code).not.toContain('"_action": {');
  });

  test("fetch wrapper tries server.ts then assets", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", { preset: "fetch", hasClient: true });
    expect(code).toContain('export * from "/app/src/server.ts"');
    expect(code).toContain('import user from "/app/src/server.ts"');
    expect(code).toContain('import actions from "virtual:oxide/actions"');
    expect(code).toContain('pathname === "/_action"');
    expect(code).toContain("await user.fetch(request, env, ctx)");
    expect(code).toContain("if (hit) return hit");
    expect(code).toContain('from "node:fs/promises"');
    expect(code).toContain("await __asset(request)");
    expect(code).toContain("await __asset(request, true)");
    expect(code).toContain("createServer");
    expect(code).toContain("response.body.getReader()");
  });

  test("fetch wrapper without client skips assets", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", { preset: "fetch" });
    expect(code).not.toContain("node:fs/promises");
    expect(code).toContain("createServer");
    expect(code).toContain("user.fetch(request, env, ctx)");
    expect(code).not.toContain("__asset");
  });

  test("celld wrapper does not serve assets or listen", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", { preset: "celld" });
    expect(code).not.toContain("node:fs/promises");
    expect(code).not.toContain("createServer");
    expect(code).toContain('new Response("Not Found", { status: 404 })');
  });

  test("stubs client, not worker", () => {
    expect(shouldStubServerModule({ consumer: "client" })).toBe(true);
    expect(shouldStubServerModule({ consumer: "server" })).toBe(false);
    expect(shouldStubServerModule({ name: "worker" })).toBe(false);
    expect(shouldStubServerModule()).toBe(true);
  });
});

describe("generated router", () => {
  test("runs exported functions over tacho /_action", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-rpc-"));
    const file = path.join(root, "test.server.ts");
    fs.writeFileSync(
      file,
      `export async function ping() { return "pong" }\nexport async function echo(value: string) { return value }\n`,
    );
    const code = generateActionsModule(scanServerFiles(root));
    const out = path.join(root, "actions.mjs");
    fs.writeFileSync(out, code);
    try {
      const { default: actions } = await import(out);
      const fetch = handle(actions, { path: "/_action" });
      const call = async (method: string, params?: unknown) => {
        const res = await fetch(
          new Request("http://localhost/_action", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          }),
        );
        return res.json();
      };
      expect(await call("test.ping")).toEqual({ jsonrpc: "2.0", id: 1, result: "pong" });
      expect(await call("test.echo", ["hello"])).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: "hello",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("streams async generators as SSE", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-stream-"));
    fs.writeFileSync(
      path.join(root, "ticks.server.ts"),
      `export async function* ticks() { yield 0; yield 1; return 2 }\n`,
    );
    const out = path.join(root, "actions.mjs");
    fs.writeFileSync(out, generateActionsModule(scanServerFiles(root)));
    try {
      const { default: actions } = await import(out);
      const res = await handle(actions, { path: "/_action" })(
        new Request("http://localhost/_action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ticks.ticks" }),
        }),
      );
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(await res.text()).toBe(
        [
          'data: {"jsonrpc":"2.0","result":0,"id":1}\n',
          'data: {"jsonrpc":"2.0","result":1,"id":1}\n',
          'event: done\ndata: {"jsonrpc":"2.0","result":2,"id":1}\n',
          "",
        ].join("\n"),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
