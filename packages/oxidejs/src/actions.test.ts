import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assetRelPath,
  generateActionsClientModule,
  generateActionsModule,
  generateClientModule,
  generateClientStub,
  generateWorkerWrapper,
  loadClientStub,
  nodeToWebRequest,
  parseExportedNames,
  pluginShouldStub,
  RequestBodyTooLargeError,
  scanServerFiles,
  shouldStubServerModule,
} from "./actions";
import { action, runWithRequest, useCtx, useEnv, useFetchCtx, useRequest } from "./context";
import { createActionHandler } from "./rpc/server";

const RPC_MODULE = path.join(import.meta.dir, "rpc/index.ts");

function writeActionsModule(root: string, code: string) {
  const out = path.join(root, "actions.mjs");
  fs.writeFileSync(out, code.replaceAll("oxidejs/rpc", RPC_MODULE));
  return out;
}

async function loadGeneratedRouter(root: string) {
  const out = writeActionsModule(root, generateActionsModule(scanServerFiles(root)));
  const mod = await import(out);
  return createActionHandler(mod.default, mod.actionsHandlers, {
    path: "/__oxide/action",
    sameOrigin: false,
  });
}

/** Parse NDJSON (`application/json-rpc`) or a legacy JSON array/object body. */
async function readRpcFrames(res: Response): Promise<unknown[]> {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  if (!trimmed.includes("\n") && trimmed.startsWith("{")) {
    return [JSON.parse(trimmed)];
  }
  return trimmed
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function readRpcFrame(res: Response): Promise<unknown> {
  const frames = await readRpcFrames(res);
  expect(frames.length).toBeGreaterThan(0);
  return frames[0];
}

async function rpcCall(
  fetch: (request: Request) => Promise<Response>,
  method: string,
  args?: unknown[],
  init: { headers?: HeadersInit; signal?: AbortSignal } = {},
) {
  const body: Record<string, unknown> = {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: { args: args ?? [] },
  };
  const requestInit: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: JSON.stringify(body),
  };
  if (init.signal) requestInit.signal = init.signal;
  const res = await fetch(new Request("http://localhost/__oxide/action", requestInit));
  return res;
}

describe("parseExportedNames", () => {
  test("finds only action-marked exports (functions, generators, consts)", () => {
    expect(
      parseExportedNames(`
        export const ping = action(async () => "pong")
        export const echo = action((x: string) => x)
        export const ticks = action(async function* () { yield 0 })
        export const add = action(async (a: number, b: number) => a + b)
        export async function hidden() { return "server-only" }
        export const helper = async () => "server-only"
      `),
    ).toEqual(["ping", "echo", "ticks", "add"]);
  });

  test("skips non-actions, types, defaults, and re-exports", () => {
    expect(
      parseExportedNames(`
        export type Ping = string
        export interface Echo { x: string }
        export async function island() {}
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
    fs.writeFileSync(
      path.join(root, "src", "test.server.ts"),
      "export const ping = action(async () => {})\n",
    );
    const mods = scanServerFiles(root);
    expect(mods).toHaveLength(1);
    expect(mods[0]?.key).toBe("test");
    expect(mods[0]?.exports).toEqual(["ping"]);

    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "lib", "test.server.ts"),
      "export const ping = action(async () => {})\n",
    );
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
  test("custom action path threads into client and server codegen", () => {
    expect(generateClientModule("http", undefined, "/custom/action")).toContain(
      '"url":"/custom/action"',
    );
    expect(generateClientModule("ws", undefined, "/custom/action")).toContain("/custom/action");
    const code = generateWorkerWrapper("/app/src/server.ts", {
      actionPath: "/custom/action",
      actionSameOrigin: true,
    });
    expect(code).toContain('p === "/custom/action" || p === "/custom/action/"');
    expect(code).toContain("sameOrigin: true");
  });

  test("client stub posts through the shared RPC client", () => {
    const stub = generateClientStub({ key: "test", exports: ["ping"], streams: [] });
    expect(stub).toContain('from "virtual:oxide/client"');
    expect(stub).toContain('import { wrapClientRpc, wrapClientStreamRpc } from "oxidejs"');
    expect(stub).toContain('client["test"]["ping"](...args.slice(0, -1), opts)');
    expect(stub).toContain('client["test"]["ping"](...args)');
    expect(stub).toContain("opts.signal instanceof AbortSignal");
    expect(generateClientModule()).toContain(
      'createClient(actionsGroup, {"url":"/__oxide/action"})',
    );
    expect(generateClientModule("http", { authorization: "Bearer x" })).toContain(
      '"authorization":"Bearer x"',
    );
    expect(generateClientModule("ws")).toContain('"transport":"ws"');
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
    const { wrapClientRpc, wrapClientStreamRpc } = await import("./action");
    const fn = new Function(
      "client",
      "wrapClientRpc",
      "wrapClientStreamRpc",
      `${generateClientStub({ key: "test", exports: ["ticks"], streams: [] })
        .replace('import { wrapClientRpc, wrapClientStreamRpc } from "oxidejs";\n', "")
        .replace('import { client } from "virtual:oxide/client";\n', "")
        .replace("export const ticks", "const ticks")}\nreturn ticks;`,
    )(client, wrapClientRpc, wrapClientStreamRpc) as (...args: unknown[]) => unknown;
    const ac = new AbortController();
    expect(await fn(10, { signal: ac.signal })).toBe(10);
    expect(await fn({ signal: ac.signal })).toEqual({ signal: ac.signal });
    expect(await fn({ n: 1 })).toEqual({ n: 1 });
    expect(await fn({ signal: "nope" })).toEqual({ signal: "nope" });
    expect(await fn(10, { signal: ac.signal, extra: true })).toBe(10);
    expect(seen).toEqual([
      { params: 10, opts: { signal: ac.signal } },
      { params: { signal: ac.signal } },
      { params: { n: 1 } },
      { params: { signal: "nope" } },
      { params: 10, opts: { signal: ac.signal, extra: true } },
    ]);
  });

  test("client actions module exposes RpcGroup only", () => {
    const code = generateActionsClientModule([
      { abs: "/app/src/test.server.ts", key: "test", exports: ["ping"], streams: [] },
      { abs: "/app/src/tasks.server.ts", key: "tasks", exports: ["list"], streams: ["list"] },
    ]);
    expect(code).toContain('Rpc.make("test.ping"');
    expect(code).toContain('Rpc.make("tasks.list", { payload:');
    expect(code).toContain("stream: true");
    expect(code).toContain("export const actionsGroup = RpcGroup.make");
    expect(code).not.toContain("AsyncLocalStorage");
    expect(code).not.toContain("actionsHandlers");
  });

  test("virtual module keys exports by file", () => {
    const code = generateActionsModule([
      { abs: "/app/src/test.server.ts", key: "test", exports: ["ping"], streams: [] },
    ]);
    expect(code).toContain('import * as __m0 from "/app/src/test.server.ts"');
    expect(code).toContain('Rpc.make("test.ping"');
    expect(code).toContain('"test.ping": ({ args }) => __run');
    expect(code).toContain(".apply(null, args))");
    expect(code).not.toContain('"_action": {');
    expect(code).not.toContain("__args");
  });

  test("fetch wrapper tries server.ts then assets", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", { preset: "fetch", hasClient: true });
    expect(code).toContain('export * from "/app/src/server.ts"');
    expect(code).toContain('import user from "/app/src/server.ts"');
    expect(code).toContain('import { actionsGroup, actionsHandlers } from "virtual:oxide/actions"');
    expect(code).toContain('p === "/__oxide/action" || p === "/__oxide/action/"');
    expect(code).toContain("request[__fetch]");
    expect(code).toContain("await user.fetch(request, env ?? {}, ctx)");
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
    expect(code).toContain('__nf = () => new Response("<h1>404 Not Found</h1>", { status: 404');
    expect(code).toContain("env?.ASSETS");
    expect(code).toContain("assets.fetch(request)");
    expect(code).toContain('oxidejs/worker-dom/install"');
    expect(code).not.toContain("ensureWorkerDom()");
    expect(code).not.toContain(": __nf()");
    expect(code).toContain("export * from");
    expect(code).toContain("...user");
  });

  test("fetch wrapper with public/ still serves assets", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", { hasPublic: true });
    expect(code).toContain("node:fs/promises");
    expect(code).toContain("__nav(request)");
  });

  test("wrapper without actions skips RPC", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", { hasActions: false });
    expect(code).not.toContain("oxidejs/rpc");
    expect(code).not.toContain("virtual:oxide/actions");
    expect(code).not.toContain("/__oxide/action");
    expect(code).toContain("user.fetch(request, env, ctx)");
  });

  test("ws wrapper upgrades /__oxide/action", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", { actions: "ws" });
    expect(code).toContain("createWsHooks");
    expect(code).toContain("crossws/adapters/node");
    expect(code).not.toContain("createActionHandler");
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
    expect(code).toContain("__actionMatch");
    expect(code).toContain("new URL(request.url).pathname");
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
      `const SECRET = "leak-me";\nexport const ping = action(async () => SECRET)\n`,
    );
    try {
      const stub = loadClientStub(file);
      expect(stub).toContain('from "virtual:oxide/client"');
      expect(stub).toContain('client["secret"]["ping"](...args.slice(0, -1), opts)');
      expect(stub).not.toContain("leak-me");
      expect(stub).not.toContain("const SECRET");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("generated router", () => {
  test("runs exported functions over /__oxide/action", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-rpc-"));
    const file = path.join(root, "test.server.ts");
    const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
    fs.writeFileSync(
      file,
      `import { action } from ${ctx};
export const ping = action(async () => "pong")
export const echo = action(async (value: string) => value)
`,
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      expect(await readRpcFrame(await rpcCall(fetch, "test.ping"))).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: "pong",
      });
      expect(await readRpcFrame(await rpcCall(fetch, "test.echo", ["hello"]))).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: "hello",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts a trailing slash on the action path", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-rpc-slash-"));
    const file = path.join(root, "test.server.ts");
    const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
    fs.writeFileSync(
      file,
      `import { action } from ${ctx};\nexport const ping = action(async () => "pong")\n`,
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const res = await fetch(
        new Request("http://localhost/__oxide/action/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "test.ping",
            params: { args: [] },
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await readRpcFrame(res)).toEqual({ jsonrpc: "2.0", id: 1, result: "pong" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves a single array argument without unwrapping", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-rpc-nest-"));
    const file = path.join(root, "test.server.ts");
    const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
    fs.writeFileSync(
      file,
      `import { action } from ${ctx};\nexport const echo = action(async (value: string[]) => value)\n`,
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const res = await fetch(
        new Request("http://localhost/__oxide/action/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "test.echo",
            params: { args: [["hello"]] },
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await readRpcFrame(res)).toEqual({ jsonrpc: "2.0", id: 1, result: ["hello"] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("void actions encode as null", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-void-"));
    const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
    fs.writeFileSync(
      path.join(root, "noop.server.ts"),
      `import { action } from ${ctx};
export const noop = action(async () => {})
`,
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      expect(await readRpcFrame(await rpcCall(fetch, "noop.noop"))).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: null,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("streams async generators as chunked JSON-RPC", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-stream-"));
    const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
    fs.writeFileSync(
      path.join(root, "ticks.server.ts"),
      `import { action } from ${ctx};
export const ticks = action(async function* () { yield 0; yield 1; return 2 })
`,
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const res = await rpcCall(fetch, "ticks.ticks");
      expect(res.headers.get("content-type")).toContain("application/json-rpc");
      const body = await readRpcFrames(res);
      expect(body).toEqual([
        { jsonrpc: "2.0", chunk: true, id: 1, result: [0] },
        { jsonrpc: "2.0", chunk: true, id: 1, result: [1] },
        { jsonrpc: "2.0", id: 1, result: null },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("stream frames flush before the generator finishes", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-stream-live-"));
    const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
    const gateFile = path.join(root, "gate");
    fs.writeFileSync(
      path.join(root, "ticks.server.ts"),
      `import { action } from ${ctx};
import fs from "node:fs";
export const ticks = action(async function* () {
  yield 0;
  while (!fs.existsSync(${JSON.stringify(gateFile)})) {
    await new Promise((r) => setTimeout(r, 5));
  }
  yield 1;
})
`,
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const res = await rpcCall(fetch, "ticks.ticks");
      expect(res.body).toBeTruthy();
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (!buf.includes("\n")) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      expect(JSON.parse(buf.split("\n")[0]!)).toEqual({
        jsonrpc: "2.0",
        chunk: true,
        id: 1,
        result: [0],
      });

      // Second frame must not arrive until the gate opens.
      const second = reader.read();
      const premature = await Promise.race([
        second.then((chunk) => ({ kind: "frame" as const, chunk })),
        new Promise<{ kind: "timeout" }>((resolve) =>
          setTimeout(() => resolve({ kind: "timeout" }), 40),
        ),
      ]);
      expect(premature.kind).toBe("timeout");

      fs.writeFileSync(gateFile, "go");
      const rest = premature.kind === "frame" ? premature.chunk : await second;
      let restText = rest.value ? decoder.decode(rest.value, { stream: true }) : "";
      while (!restText.includes("\n") && !rest.done) {
        const next = await reader.read();
        if (next.done) break;
        restText += decoder.decode(next.value, { stream: true });
      }
      expect(JSON.parse(restText.split("\n").find((l) => l.length > 0)!)).toEqual({
        jsonrpc: "2.0",
        chunk: true,
        id: 1,
        result: [1],
      });
      await reader.cancel();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("useRequest() works inside an async generator", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-gen-req-"));
    fs.writeFileSync(
      path.join(root, "who.server.ts"),
      `import { action, useRequest } from ${JSON.stringify(path.join(import.meta.dir, "context.ts"))};
export const who = action(async function* () { yield useRequest().headers.get("x-user") })
`,
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const res = await rpcCall(fetch, "who.who", undefined, { headers: { "x-user": "ada" } });
      const body = await readRpcFrames(res);
      expect((body[0] as { result?: unknown })?.result).toEqual(["ada"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("useRequest() stays available after a yield in an async generator", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-gen-req-after-"));
    fs.writeFileSync(
      path.join(root, "who.server.ts"),
      `import { action, useRequest } from ${JSON.stringify(path.join(import.meta.dir, "context.ts"))};
export const who = action(async function* () {
  yield "start";
  yield useRequest().headers.get("x-user");
})
`,
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const res = await rpcCall(fetch, "who.who", undefined, { headers: { "x-user": "ada" } });
      const body = await readRpcFrames(res);
      expect(body).toEqual([
        { jsonrpc: "2.0", chunk: true, id: 1, result: ["start"] },
        { jsonrpc: "2.0", chunk: true, id: 1, result: ["ada"] },
        { jsonrpc: "2.0", id: 1, result: null },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("useRequest() reads the inbound Request inside an action", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-req-"));
    fs.writeFileSync(
      path.join(root, "who.server.ts"),
      `import { action, useRequest } from ${JSON.stringify(path.join(import.meta.dir, "context.ts"))};
export const who = action(async () => useRequest().headers.get("x-user"))
`,
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const res = await rpcCall(fetch, "who.who", undefined, { headers: { "x-user": "ada" } });
      expect(await readRpcFrame(res)).toEqual({ jsonrpc: "2.0", id: 1, result: "ada" });
      expect(() => useRequest()).toThrow("request context is unavailable");
      expect(() => useCtx()).toThrow("request context is unavailable");
      expect(() => useEnv()).toThrow("request context is unavailable");
      expect(() => useFetchCtx()).toThrow("request context is unavailable");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("action adds typed cancellation and Atom.fn-shaped handles", async () => {
    const pingFn = async () => "pong" as const;
    const ping = action(pingFn);
    const echo = action(async (value: string) => value);
    const signal = new AbortController().signal;

    expect(ping.$$atom).toBe(1);
    expect(typeof ping.set).toBe("function");
    expect(typeof ping.bind).toBe("function");
    expect(await ping({ signal })).toBe("pong");
    expect(await echo("ok", { signal })).toBe("ok");
    expect(await ping.set()).toBe("pong");
  });

  test("runWithRequest always provides the current Request", () => {
    const controller = new AbortController();
    const request = new Request("http://localhost/frame", { signal: controller.signal });

    runWithRequest(
      request,
      () => {
        expect(useRequest()).toBe(request);
        expect(useRequest().signal).toBe(controller.signal);
        expect(useEnv<{ TASKS: boolean }>()).toEqual({ TASKS: true });
      },
      { req: new Request("http://wrong/"), env: { TASKS: true } },
    );
  });

  test("useEnv() and useFetchCtx() read RPC context extras", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-env-"));
    fs.writeFileSync(
      path.join(root, "who.server.ts"),
      `import { action, useCtx, useEnv, useFetchCtx } from ${JSON.stringify(path.join(import.meta.dir, "context.ts"))};
export const who = action(async () => {
  const env = useEnv();
  useFetchCtx()?.waitUntil?.(Promise.resolve());
  return { secret: env.SECRET, user: useCtx().user };
})
`,
    );
    const out = writeActionsModule(root, generateActionsModule(scanServerFiles(root)));
    try {
      const mod = await import(out);
      const waited: Promise<unknown>[] = [];
      const fetch = createActionHandler(mod.default, mod.actionsHandlers, {
        path: "/__oxide/action",
        sameOrigin: false,
        createContext: () => ({
          req: new Request("http://localhost/__oxide/action"),
          env: { SECRET: "from-env" },
          fetchCtx: { waitUntil: (p: Promise<unknown>) => waited.push(p) },
          user: "ada",
        }),
      });
      const res = await rpcCall(fetch, "who.who");
      expect(await readRpcFrame(res)).toEqual({
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
      `import { action, useRequest } from ${JSON.stringify(path.join(import.meta.dir, "context.ts"))};
export const wait = action(async () => {
  const req = useRequest();
  if (req.signal.aborted) return "aborted";
  await new Promise((resolve) => req.signal.addEventListener("abort", resolve, { once: true }));
  return "aborted";
})
`,
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const ac = new AbortController();
      const pending = rpcCall(fetch, "wait.wait", undefined, { signal: ac.signal });
      await Promise.resolve();
      ac.abort();
      expect(await readRpcFrame(await pending)).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: "aborted",
      });
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

  test("nodeToWebRequest enforces the body limit", async () => {
    const { EventEmitter } = await import("node:events");
    const req = Object.assign(new EventEmitter(), {
      method: "POST",
      url: "/__oxide/action",
      headers: { host: "localhost" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("too large");
      },
    });
    await expect(nodeToWebRequest(req as never, 3)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  test("nodeToWebRequest stays open after draining a POST body", async () => {
    const { EventEmitter } = await import("node:events");
    const chunks = [Buffer.from('{"jsonrpc":"2.0"}')];
    const req = Object.assign(new EventEmitter(), {
      method: "POST",
      url: "/__oxide/action",
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

  test("/__oxide/action is POST-only and rejects unknown methods", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-wire-"));
    const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
    fs.writeFileSync(
      path.join(root, "test.server.ts"),
      `import { action } from ${ctx};\nexport const ping = action(async () => "pong")\n`,
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const get = await fetch(new Request("http://localhost/__oxide/action"));
      expect(get.status).toBe(405);
      expect(get.headers.get("allow")).toBe("POST");
      const miss = await fetch(
        new Request("http://localhost/__oxide/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test.secret" }),
        }),
      );
      expect(await readRpcFrame(miss)).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found" },
      });
      const proto = await fetch(
        new Request("http://localhost/__oxide/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "__proto__.ping" }),
        }),
      );
      expect(await readRpcFrame(proto)).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found" },
      });
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

  test("invalid params are rejected", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-params-"));
    const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
    fs.writeFileSync(
      path.join(root, "test.server.ts"),
      `import { action } from ${ctx};\nexport const echo = action(async (value) => value ?? "empty")\n`,
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const call = (params: unknown) =>
        fetch(
          new Request("http://localhost/__oxide/action", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test.echo", params }),
          }),
        ).then((res) => readRpcFrame(res));
      expect(await call({ 0: "sneak" })).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "Invalid params" },
      });
      expect(await call({ args: ["ok"] })).toEqual({ jsonrpc: "2.0", id: 1, result: "ok" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("thrown errors scrub Defect payloads (no message leak)", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-scrub-"));
    const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
    fs.writeFileSync(
      path.join(root, "test.server.ts"),
      `import { action } from ${ctx};\nexport const boom = action(async () => { throw new Error("secret-leak-check"); })\n`,
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const res = await rpcCall(fetch, "test.boom");
      const body = await readRpcFrame(res);
      expect(body).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Internal error" },
      });
      expect(JSON.stringify(body)).not.toContain("secret-leak-check");
      expect(JSON.stringify(body)).not.toContain("Defect");
      expect(JSON.stringify(body)).not.toContain("_tag");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
