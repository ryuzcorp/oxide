import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handle } from "tacho/transport/fetch";
import {
  assetRelPath,
  generateActionsModule,
  generateClientModule,
  generateClientStub,
  generateWorkerWrapper,
  loadClientStub,
  nodeToWebRequest,
  parseExportedNames,
  pluginShouldStub,
  scanServerFiles,
  shouldStubServerModule,
} from "./actions";
import { useCtx, useEnv, useFetchCtx, useRequest } from "./context";

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

  test("skips types, defaults, and re-exports", () => {
    expect(
      parseExportedNames(`
        export type Ping = string
        export interface Echo { x: string }
        export default function nope() {}
        export { ping } from "./other"
        export * from "./all"
        const hidden = 1
        export { hidden }
      `),
    ).toEqual([]);
  });
});

describe("scanServerFiles", () => {
  test("finds TypeScript and JavaScript server modules", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-actions-"));
    for (const ext of ["ts", "tsx", "js", "jsx"]) {
      fs.writeFileSync(
        path.join(root, `${ext}.server.${ext}`),
        "export async function ping() {}\n",
      );
    }
    try {
      expect(scanServerFiles(root).map((mod) => mod.key)).toEqual(["js", "jsx", "ts", "tsx"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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

  test("skips ignored dirs and hidden files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-scan-"));
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "dep.server.ts"),
      "export async function leak() {}\n",
    );
    fs.writeFileSync(
      path.join(root, "dist", "built.server.ts"),
      "export async function leak() {}\n",
    );
    fs.writeFileSync(path.join(root, ".secret.server.ts"), "export async function leak() {}\n");
    fs.writeFileSync(path.join(root, "ok.server.ts"), "export async function ping() {}\n");
    try {
      const mods = scanServerFiles(root);
      expect(mods.map((m) => m.key)).toEqual(["ok"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("codegen", () => {
  test("client stub posts through the shared tacho client", () => {
    const stub = generateClientStub({ key: "test", exports: ["ping"] });
    expect(stub).toContain('from "virtual:oxide/client"');
    expect(stub).toContain('client["test"]["ping"](args.slice(0, -1), opts)');
    expect(stub).toContain("opts.signal instanceof AbortSignal");
    expect(generateClientModule()).toContain('createClient({"url":"/_action"})');
    expect(generateClientModule("http", { authorization: "Bearer x" })).toContain(
      '"authorization":"Bearer x"',
    );
    expect(generateClientModule("ws")).toContain("tacho/client/ws");
  });

  test("client stub peels { signal } and keeps other last args", async () => {
    const seen: { params?: unknown; opts?: unknown }[] = [];
    const client = {
      test: {
        ticks: (params: unknown, opts?: unknown) => {
          seen.push({ params, opts });
          return params;
        },
      },
    };
    const fn = new Function(
      "client",
      `${generateClientStub({ key: "test", exports: ["ticks"] })
        .replace('import { client } from "virtual:oxide/client";\n', "")
        .replace("export const ticks", "const ticks")}\nreturn ticks;`,
    )(client) as (...args: unknown[]) => unknown;
    const ac = new AbortController();
    expect(fn(10, { signal: ac.signal })).toEqual([10]);
    expect(fn({ signal: ac.signal })).toEqual([]);
    expect(fn({ n: 1 })).toEqual([{ n: 1 }]);
    expect(fn({ signal: "nope" })).toEqual([{ signal: "nope" }]);
    expect(fn(10, { signal: ac.signal, extra: true })).toEqual([
      10,
      { signal: ac.signal, extra: true },
    ]);
    expect(seen).toEqual([
      { params: [10], opts: { signal: ac.signal } },
      { params: [], opts: { signal: ac.signal } },
      { params: [{ n: 1 }] },
      { params: [{ signal: "nope" }] },
      { params: [10, { signal: ac.signal, extra: true }] },
    ]);
  });

  test("virtual module keys exports by file", () => {
    const code = generateActionsModule([
      { abs: "/app/src/test.server.ts", key: "test", exports: ["ping"] },
    ]);
    expect(code).toContain('import * as __m0 from "/app/src/test.server.ts"');
    expect(code).toContain('"test": {');
    expect(code).toContain('"ping": rpc.run');
    expect(code).toContain("__als.run(ctx, () => out.next");
    expect(code).toContain(".apply(null,");
    expect(code).not.toContain('"_action": {');
  });

  test("fetch wrapper tries server.ts then assets", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", { preset: "fetch", hasClient: true });
    expect(code).toContain('export * from "/app/src/server.ts"');
    expect(code).toContain('import user from "/app/src/server.ts"');
    expect(code).toContain('import actions from "virtual:oxide/actions"');
    expect(code).toContain('pathname === "/_action"');
    expect(code).toContain("request[__fetch]");
    expect(code).toContain("await user.fetch(request, env, ctx)");
    expect(code).toContain("if (hit) return hit");
    expect(code).toContain('from "node:fs/promises"');
    expect(code).toContain("await __asset(request)");
    expect(code).toContain("__nav(request)");
    expect(code).toContain("woff2");
    expect(code).toContain("immutable");
    expect(code).toContain("createServer");
    expect(code).toContain("signal: ac.signal");
    expect(code).toContain('req.once("aborted"');
    expect(code).toContain("response.body.getReader()");
    expect(code).toContain("...user");
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
    expect(code).toContain("export * from");
    expect(code).toContain("...user");
  });

  test("fetch wrapper with public/ still serves assets", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", { hasPublic: true });
    expect(code).toContain("node:fs/promises");
    expect(code).toContain("__nav(request)");
  });

  test("wrapper without actions skips tacho", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", { hasActions: false });
    expect(code).not.toContain("tacho");
    expect(code).not.toContain("virtual:oxide/actions");
    expect(code).not.toContain("/_action");
    expect(code).toContain("user.fetch(request, env, ctx)");
  });

  test("ws wrapper upgrades /_action", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", { actions: "ws" });
    expect(code).toContain("tacho/transport/ws");
    expect(code).toContain("crossws/adapters/node");
    expect(code).not.toContain("tacho/transport/fetch");
  });

  test("asset helper rejects traversal and absolute joins", () => {
    expect(assetRelPath("/app.js")).toBe("app.js");
    expect(assetRelPath("/")).toBe("index.html");
    expect(assetRelPath("/missing", true)).toBe("index.html");
    expect(assetRelPath("/../secret")).toBeNull();
    expect(assetRelPath("/%2e%2e/secret")).toBeNull();
    expect(assetRelPath("/foo/../../etc/passwd")).toBeNull();
    expect(assetRelPath("/app.js%00.txt")).toBeNull();
    expect(assetRelPath("app.js")).toBeNull();
    const code = generateWorkerWrapper("/app/src/server.ts", { preset: "fetch", hasClient: true });
    expect(code).toContain("rel.startsWith");
    expect(code).toContain('file.split("/").includes("..")');
  });

  test("asset helper blocks double-slash absolute path escape", () => {
    // //etc/passwd after slice(1) becomes /etc/passwd (absolute)
    // path.resolve would escape the asset root
    expect(assetRelPath("//etc/passwd")).toBeNull();
    expect(assetRelPath("///etc/passwd")).toBeNull();
    expect(assetRelPath("////etc/passwd")).toBeNull();
  });

  test("asset helper never returns an absolute path", () => {
    const vectors = [
      "/",
      "/app.js",
      "//x",
      "///x",
      "/foo/bar",
      "/foo/../bar",
      "/%2e%2e/x",
      "/foo%00",
      "/foo%5c..%5cbar",
      "/foo%2f..%2fbar",
      "/../../../etc/shadow",
      "/..%2f..%2fetc%2fshadow",
      "/..",
      "/foo/..",
      "/foo/.",
    ];
    for (const v of vectors) {
      const result = assetRelPath(v);
      if (result !== null) {
        expect(result.startsWith("/")).toBe(false);
        expect(result.split("/").includes("..")).toBe(false);
      }
    }
  });

  test("asset helper blocks null bytes pre and post decode", () => {
    expect(assetRelPath("/foo\0bar")).toBeNull();
    expect(assetRelPath("/foo%00bar")).toBeNull();
    expect(assetRelPath("/%00")).toBeNull();
  });

  test("asset helper rejects relative paths without leading slash", () => {
    expect(assetRelPath("app.js")).toBeNull();
    expect(assetRelPath("../secret")).toBeNull();
    expect(assetRelPath("")).toBeNull();
  });

  test("asset helper allows valid nested paths", () => {
    expect(assetRelPath("/assets/js/app.js")).toBe("assets/js/app.js");
    expect(assetRelPath("/img/logo.png")).toBe("img/logo.png");
    expect(assetRelPath("/.vite/manifest.json")).toBe(".vite/manifest.json");
  });

  test("generated __rel matches assetRelPath for all attack vectors", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", { preset: "fetch", hasClient: true });
    // Extract the __rel function from generated code and evaluate it
    const match = code.match(/function __rel\(pathname, spa\) \{[\s\S]*?\n\}/)?.[0];
    expect(match).toBeTruthy();
    const __rel = new Function(`${match}; return __rel;`)() as (
      pathname: string,
      spa?: boolean,
    ) => string | undefined;

    const vectors: [string, boolean | undefined][] = [
      ["/app.js", undefined],
      ["/", undefined],
      ["/missing", true],
      ["/../secret", undefined],
      ["/%2e%2e/secret", undefined],
      ["/foo/../../etc/passwd", undefined],
      ["/app.js%00.txt", undefined],
      ["app.js", undefined],
      ["//etc/passwd", undefined],
      ["///etc/passwd", undefined],
      ["/foo\0bar", undefined],
      ["/foo%00bar", undefined],
      ["../secret", undefined],
      ["", undefined],
      ["/assets/js/app.js", undefined],
      ["/.vite/manifest.json", undefined],
    ];
    for (const [pathname, spa] of vectors) {
      const expected = assetRelPath(pathname, spa);
      const actual = __rel(pathname, spa) ?? null;
      expect(actual).toBe(expected);
    }
  });

  test("generated server uses req.url safely with URL constructor", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", { preset: "fetch", hasClient: true });
    // The generated code uses new URL(request.url).pathname to extract the path,
    // not raw string manipulation. This ensures URL parsing normalization.
    expect(code).toContain("new URL(request.url).pathname");
    // The action gate also uses pathname comparison, not raw string matching
    expect(code).toContain('new URL(request.url).pathname === "/_action"');
  });

  test("generated __asset serves real files from a public/ dir", async () => {
    // Build a fake dist/client like the plugin's build output
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-assets-"));
    const client = path.join(root, "dist", "client");
    fs.mkdirSync(client, { recursive: true });
    fs.writeFileSync(path.join(client, "index.html"), "<html>home</html>");
    fs.writeFileSync(path.join(client, "logo.png"), Buffer.from([1, 2, 3, 4]));
    fs.mkdirSync(path.join(client, "nested"));
    fs.writeFileSync(path.join(client, "nested", "deep.txt"), "deep-content");
    // A secret file just outside the asset root — must never be reachable
    fs.writeFileSync(path.join(root, "secret.txt"), "top-secret");

    try {
      const code = generateWorkerWrapper("/app/src/server.ts", {
        preset: "fetch",
        hasPublic: true,
      });
      // The asset block sits between the __assets const and the app object.
      const start = code.indexOf("const __assets");
      const end = code.indexOf("const app =");
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const assetBlock = code.slice(start, end);
      // Strip the import lines and the __assets const; we inject those via scope.
      const body = assetBlock
        .replace(/^import .*\n/gm, "")
        .replace(/^const __assets = .*;\n?/m, "");
      const factory = new Function(
        "readFile",
        "extname",
        "join",
        "__assets",
        `${body}\nreturn { __rel, __asset };`,
      ) as (
        readFile: (p: string) => Promise<Buffer>,
        extname: typeof path.extname,
        join: typeof path.join,
        assets: string,
      ) => {
        __rel: (pathname: string, spa?: boolean) => string | undefined;
        __asset: (request: Request, spa?: boolean) => Promise<Response | undefined>;
      };
      const { __asset } = factory(
        (p: string) => import("node:fs/promises").then((m) => m.readFile(p)),
        path.extname,
        path.join,
        client,
      );

      // Valid asset served with correct content-type
      const index = await __asset(new Request("http://x/index.html"));
      expect(index?.status).toBe(200);
      expect(await index!.text()).toBe("<html>home</html>");
      expect(index!.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(index!.headers.get("cache-control")).toBe("no-cache");

      // Binary asset keeps its bytes and gets the right type
      const png = await __asset(new Request("http://x/logo.png"));
      expect(png?.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await png!.arrayBuffer())).toEqual(Buffer.from([1, 2, 3, 4]));

      // Nested path
      const deep = await __asset(new Request("http://x/nested/deep.txt"));
      expect(await deep!.text()).toBe("deep-content");
      expect(deep!.headers.get("content-type")).toBe("application/octet-stream");

      // Missing file → undefined (caller returns 404)
      expect(await __asset(new Request("http://x/missing.png"))).toBeUndefined();

      // SPA fallback resolves unknown paths to index.html
      const spa = await __asset(new Request("http://x/some/route"), true);
      expect(await spa!.text()).toBe("<html>home</html>");

      // Traversal and double-slash are blocked at the __rel gate
      expect(await __asset(new Request("http://x/../secret.txt"))).toBeUndefined();
      expect(await __asset(new Request("http://x/..%2fsecret.txt"))).toBeUndefined();
      expect(await __asset(new Request("http://x//etc/passwd"))).toBeUndefined();
      expect(await __asset(new Request("http://x/%2e%2e/secret.txt"))).toBeUndefined();
      // SPA fallback maps traversal paths to index.html — never outside assets
      const spaTraversal = await __asset(new Request("http://x/../secret.txt"), true);
      expect(await spaTraversal!.text()).toBe("<html>home</html>");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("stubs client, not worker", () => {
    expect(shouldStubServerModule({ consumer: "client" })).toBe(true);
    expect(shouldStubServerModule({ consumer: "server" })).toBe(false);
    expect(shouldStubServerModule({ config: { consumer: "server" } })).toBe(false);
    expect(shouldStubServerModule({ name: "worker" })).toBe(false);
    expect(shouldStubServerModule({ name: "ssr" })).toBe(false);
    expect(shouldStubServerModule({ name: "web" })).toBe(true);
    expect(shouldStubServerModule({ name: "browser" })).toBe(true);
    expect(shouldStubServerModule(undefined, { ssr: true })).toBe(false);
    expect(shouldStubServerModule(undefined, { target: "node" })).toBe(false);
    expect(shouldStubServerModule(undefined, { target: "web" })).toBe(true);
    expect(shouldStubServerModule()).toBe(true);
  });

  test("plugin this follows Vite consumer and webpack target", () => {
    expect(pluginShouldStub({ environment: { config: { consumer: "server" } } })).toBe(false);
    expect(pluginShouldStub({ environment: { config: { consumer: "client" } } })).toBe(true);
    expect(pluginShouldStub({}, { ssr: true })).toBe(false);
    expect(
      pluginShouldStub({
        getNativeBuildContext: () => ({ compiler: { options: { target: "node" } } }),
      }),
    ).toBe(false);
    expect(
      pluginShouldStub({
        getNativeBuildContext: () => ({ compiler: { name: "web" } }),
      }),
    ).toBe(true);
  });

  test("client stub load never includes server source", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-stub-"));
    const file = path.join(root, "secret.server.ts");
    fs.writeFileSync(
      file,
      `const SECRET = "leak-me";\nexport async function ping() { return SECRET }\n`,
    );
    try {
      const stub = loadClientStub(file);
      expect(stub).toContain('from "virtual:oxide/client"');
      expect(stub).toContain('client["secret"]["ping"](args.slice(0, -1), opts)');
      expect(stub).not.toContain("leak-me");
      expect(stub).not.toContain("const SECRET");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  test("useRequest() works inside an async generator", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-gen-req-"));
    fs.writeFileSync(
      path.join(root, "who.server.ts"),
      `import { useRequest } from ${JSON.stringify(path.join(import.meta.dir, "context.ts"))};
export async function* who() { yield useRequest().headers.get("x-user") }
`,
    );
    const out = path.join(root, "actions.mjs");
    fs.writeFileSync(out, generateActionsModule(scanServerFiles(root)));
    try {
      const { default: actions } = await import(out);
      const res = await handle(actions, { path: "/_action" })(
        new Request("http://localhost/_action", {
          method: "POST",
          headers: { "content-type": "application/json", "x-user": "ada" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "who.who" }),
        }),
      );
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(await res.text()).toContain('"result":"ada"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("useRequest() reads the inbound Request inside an action", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-req-"));
    fs.writeFileSync(
      path.join(root, "who.server.ts"),
      `import { useRequest } from ${JSON.stringify(path.join(import.meta.dir, "context.ts"))};
export async function who() { return useRequest().headers.get("x-user") }
`,
    );
    const out = path.join(root, "actions.mjs");
    fs.writeFileSync(out, generateActionsModule(scanServerFiles(root)));
    try {
      const { default: actions } = await import(out);
      const res = await handle(actions, { path: "/_action" })(
        new Request("http://localhost/_action", {
          method: "POST",
          headers: { "content-type": "application/json", "x-user": "ada" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "who.who" }),
        }),
      );
      expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: "ada" });
      expect(() => useRequest()).toThrow("outside an action");
      expect(() => useCtx()).toThrow("outside an action");
      expect(() => useEnv()).toThrow("outside an action");
      expect(() => useFetchCtx()).toThrow("outside an action");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("useEnv() and useFetchCtx() read tacho ctx extras", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-env-"));
    fs.writeFileSync(
      path.join(root, "who.server.ts"),
      `import { useCtx, useEnv, useFetchCtx } from ${JSON.stringify(path.join(import.meta.dir, "context.ts"))};
export async function who() {
  const env = useEnv();
  useFetchCtx()?.waitUntil?.(Promise.resolve());
  return { secret: env.SECRET, user: useCtx().user };
}
`,
    );
    const out = path.join(root, "actions.mjs");
    fs.writeFileSync(out, generateActionsModule(scanServerFiles(root)));
    try {
      const { default: actions } = await import(out);
      const waited: Promise<unknown>[] = [];
      const res = await handle(actions, {
        path: "/_action",
        createContext: () => ({
          env: { SECRET: "from-env" },
          fetchCtx: { waitUntil: (p: Promise<unknown>) => waited.push(p) },
          user: "ada",
        }),
      })(
        new Request("http://localhost/_action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "who.who" }),
        }),
      );
      expect(await res.json()).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: { secret: "from-env", user: "ada" },
      });
      expect(waited).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("unary action sees useRequest().signal abort", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-abort-"));
    fs.writeFileSync(
      path.join(root, "wait.server.ts"),
      `import { useRequest } from ${JSON.stringify(path.join(import.meta.dir, "context.ts"))};
export async function wait() {
  const req = useRequest();
  if (req.signal.aborted) return "aborted";
  await new Promise((resolve) => req.signal.addEventListener("abort", resolve, { once: true }));
  return "aborted";
}
`,
    );
    const out = path.join(root, "actions.mjs");
    fs.writeFileSync(out, generateActionsModule(scanServerFiles(root)));
    try {
      const { default: actions } = await import(out);
      const ac = new AbortController();
      const pending = handle(actions, { path: "/_action" })(
        new Request("http://localhost/_action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "wait.wait" }),
          signal: ac.signal,
        }),
      );
      await Promise.resolve();
      ac.abort();
      expect(await (await pending).json()).toEqual({ jsonrpc: "2.0", id: 1, result: "aborted" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("nodeToWebRequest abort follows IncomingMessage aborted", async () => {
    const { EventEmitter } = await import("node:events");
    const req = Object.assign(new EventEmitter(), {
      method: "GET",
      url: "/",
      headers: { host: "localhost" },
      aborted: false,
      destroyed: true,
    });
    const request = await nodeToWebRequest(req as never);
    expect(request.signal.aborted).toBe(false);
    req.emit("close");
    expect(request.signal.aborted).toBe(false);
    req.emit("aborted");
    expect(request.signal.aborted).toBe(true);
  });

  test("nodeToWebRequest stays open after draining a POST body", async () => {
    const { EventEmitter } = await import("node:events");
    const chunks = [Buffer.from('{"jsonrpc":"2.0"}')];
    const req = Object.assign(new EventEmitter(), {
      method: "POST",
      url: "/_action",
      headers: { host: "localhost" },
      destroyed: true,
      async *[Symbol.asyncIterator]() {
        yield* chunks;
      },
    });
    const request = await nodeToWebRequest(req as never);
    expect(request.signal.aborted).toBe(false);
    expect(await request.text()).toBe('{"jsonrpc":"2.0"}');
  });

  test("/_action is POST-only and rejects unknown methods", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-wire-"));
    fs.writeFileSync(
      path.join(root, "test.server.ts"),
      `export async function ping() { return "pong" }\n`,
    );
    const out = path.join(root, "actions.mjs");
    fs.writeFileSync(out, generateActionsModule(scanServerFiles(root)));
    try {
      const { default: actions } = await import(out);
      const fetch = handle(actions, { path: "/_action" });
      const get = await fetch(new Request("http://localhost/_action"));
      expect(get.status).toBe(405);
      expect(get.headers.get("allow")).toBe("POST");
      const miss = await fetch(
        new Request("http://localhost/_action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test.secret" }),
        }),
      );
      expect(await miss.json()).toMatchObject({
        error: { code: -32601 },
        id: 1,
      });
      const proto = await fetch(
        new Request("http://localhost/_action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "__proto__.ping" }),
        }),
      );
      expect(await proto.json()).toMatchObject({ error: { code: -32601 } });
      const other = await fetch(
        new Request("http://localhost/api", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test.ping" }),
        }),
      );
      expect(other.status).toBe(404);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-array params do not become arguments", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-params-"));
    fs.writeFileSync(
      path.join(root, "test.server.ts"),
      `export async function echo(value) { return value ?? "empty" }\n`,
    );
    const out = path.join(root, "actions.mjs");
    fs.writeFileSync(out, generateActionsModule(scanServerFiles(root)));
    try {
      const { default: actions } = await import(out);
      const fetch = handle(actions, { path: "/_action" });
      const call = (params: unknown) =>
        fetch(
          new Request("http://localhost/_action", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test.echo", params }),
          }),
        ).then((res) => res.json());
      expect(await call({ 0: "sneak" })).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: "empty",
      });
      expect(await call(["ok"])).toEqual({ jsonrpc: "2.0", id: 1, result: "ok" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
