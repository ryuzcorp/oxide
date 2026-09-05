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
import {
  __setInWebcontainerForTests,
  action,
  getRequestStore,
  runWithRequest,
  useCtx,
  useEnv,
  useFetchCtx,
  useRequest,
  withRequestEntry,
  withRequestStore,
} from "./context";
import { createActionHandler } from "./rpc/server";

const RPC_MODULE = path.join(import.meta.dir, "rpc/index.ts");
const OXIDE_RUNTIME = path.join(import.meta.dir, "context.ts");

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface RpcRequestBody {
  id: number;
  jsonrpc: "2.0";
  method: string;
  params: { args: JsonValue[] };
}

interface RpcCallInit {
  headers?: HeadersInit;
  signal?: AbortSignal;
}

interface ClientStubOpts {
  extra?: boolean;
  signal?: AbortSignal;
}

interface ClientStubCall {
  opts?: ClientStubOpts;
  params?: JsonValue | ClientStubOpts;
}

const expectDefined = function expectDefined<T>(
  value: T | null | undefined
): T {
  if (value === null || value === undefined) {
    throw new Error("expected value to be defined");
  }
  return value;
};

const writeActionsModule = function writeActionsModule(
  root: string,
  code: string
) {
  const out = path.join(root, "actions.mjs");
  fs.writeFileSync(
    out,
    code
      .replaceAll("oxidejs/rpc", RPC_MODULE)
      .replaceAll('from "oxidejs"', `from ${JSON.stringify(OXIDE_RUNTIME)}`)
  );
  return out;
};

const loadGeneratedRouter = async function loadGeneratedRouter(root: string) {
  const out = writeActionsModule(
    root,
    generateActionsModule(scanServerFiles(root))
  );
  const mod = await import(out);
  return createActionHandler(mod.default, mod.actionsHandlers, {
    path: "/__oxide/action",
    sameOrigin: false,
  });
};

const parseRpcLine = function parseRpcLine(line: string): JsonValue {
  // SAFETY: each NDJSON line is a JSON-RPC frame from the action handler.
  return JSON.parse(line) as JsonValue;
};

/** Parse NDJSON (`application/json-rpc`) or a legacy JSON array/object body. */
const readRpcFrames = async function readRpcFrames(
  res: Response
): Promise<JsonValue[]> {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    // SAFETY: RPC test response body is JSON from the action handler.
    const parsed = JSON.parse(trimmed) as JsonValue;
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  if (!trimmed.includes("\n") && trimmed.startsWith("{")) {
    // SAFETY: single JSON-RPC object body from the action handler.
    return [JSON.parse(trimmed) as JsonValue];
  }
  return trimmed
    .split("\n")
    .filter((line) => line.length > 0)
    .map(parseRpcLine);
};

const readRpcFrame = async function readRpcFrame(
  res: Response
): Promise<JsonValue> {
  const frames = await readRpcFrames(res);
  expect(frames.length).toBeGreaterThan(0);
  return expectDefined(frames[0]);
};

const rpcCall = async function rpcCall(
  fetch: (request: Request) => Promise<Response>,
  method: string,
  args?: JsonValue[],
  init: RpcCallInit = {}
) {
  const body = {
    id: 1,
    jsonrpc: "2.0" as const,
    method,
    params: { args: args ?? [] },
  } satisfies RpcRequestBody;
  const requestInit: RequestInit = {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...init.headers },
    method: "POST",
  };
  if (init.signal) {
    requestInit.signal = init.signal;
  }
  const res = await fetch(
    new Request("http://localhost/__oxide/action", requestInit)
  );
  return res;
};

const readStreamUntilNewline = async function readStreamUntilNewline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buf = ""
): Promise<{ buf: string; done: boolean }> {
  if (buf.includes("\n")) {
    return { buf, done: false };
  }
  const { done, value } = await reader.read();
  if (done) {
    return { buf, done: true };
  }
  return readStreamUntilNewline(
    reader,
    decoder,
    buf + decoder.decode(value, { stream: true })
  );
};

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
      `)
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
      `)
    ).toEqual([]);
  });
});

describe("scanServerFiles", () => {
  test("finds TypeScript and JavaScript server modules", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-actions-"));
    for (const ext of ["ts", "tsx", "js", "jsx"]) {
      fs.writeFileSync(
        path.join(root, `${ext}.server.${ext}`),
        "export async function ping() {}\n"
      );
    }
    try {
      expect(scanServerFiles(root).map((mod) => mod.key)).toEqual([
        "js",
        "jsx",
        "ts",
        "tsx",
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("keys by filename and rejects collisions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-actions-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "test.server.ts"),
      "export const ping = action(async () => {})\n"
    );
    const mods = scanServerFiles(root);
    expect(mods).toHaveLength(1);
    expect(mods[0]?.key).toBe("test");
    expect(mods[0]?.exports).toEqual(["ping"]);

    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "lib", "test.server.ts"),
      "export const ping = action(async () => {})\n"
    );
    expect(() => scanServerFiles(root)).toThrow(
      'duplicate server module key "test"'
    );
    fs.rmSync(root, { force: true, recursive: true });
  });

  test("skips ignored dirs and hidden files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-scan-"));
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "dep.server.ts"),
      "export async function leak() {}\n"
    );
    fs.writeFileSync(
      path.join(root, "dist", "built.server.ts"),
      "export async function leak() {}\n"
    );
    fs.writeFileSync(
      path.join(root, ".secret.server.ts"),
      "export async function leak() {}\n"
    );
    fs.writeFileSync(
      path.join(root, "ok.server.ts"),
      "export async function ping() {}\n"
    );
    try {
      const mods = scanServerFiles(root);
      expect(mods.map((m) => m.key)).toEqual(["ok"]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("codegen", () => {
  test("custom action path threads into client and server codegen", () => {
    expect(generateClientModule("http", undefined, "/custom/action")).toContain(
      '"url":"/custom/action"'
    );
    expect(generateClientModule("ws", undefined, "/custom/action")).toContain(
      "/custom/action"
    );
    const code = generateWorkerWrapper("/app/src/server.ts", {
      actionPath: "/custom/action",
      actionSameOrigin: true,
    });
    expect(code).toContain('p === "/custom/action" || p === "/custom/action/"');
    expect(code).toContain("sameOrigin: true");
  });

  test("client stub posts through the shared RPC client", () => {
    const stub = generateClientStub({
      exports: ["ping"],
      key: "test",
      streams: [],
    });
    expect(stub).toContain('from "virtual:oxide/client"');
    expect(stub).toContain(
      'import { wrapClientRpc, wrapClientStreamRpc } from "oxidejs"'
    );
    expect(stub).toContain(
      'client["test"]["ping"](...args.slice(0, -1), opts)'
    );
    expect(stub).toContain('client["test"]["ping"](...args)');
    expect(stub).toContain("opts.signal instanceof AbortSignal");
    expect(generateClientModule()).toContain(
      'createClient(actionsGroup, {"url":"/__oxide/action"})'
    );
    expect(
      generateClientModule("http", { authorization: "Bearer x" })
    ).toContain('"authorization":"Bearer x"');
    expect(generateClientModule("ws")).toContain('"transport":"ws"');
  });

  test("client stub peels { signal } and keeps other last args", async () => {
    const seen: ClientStubCall[] = [];
    const client = {
      test: {
        ticks: (params: JsonValue | ClientStubOpts, opts?: ClientStubOpts) => {
          if (opts === undefined) {
            seen.push({ params });
          } else {
            seen.push({ opts, params });
          }
          return params;
        },
      },
    };
    const { wrapClientRpc, wrapClientStreamRpc } = await import("./action");
    const stubSource = `${generateClientStub({
      exports: ["ticks"],
      key: "test",
      streams: [],
    })
      .replace(
        'import { wrapClientRpc, wrapClientStreamRpc } from "oxidejs";\n',
        ""
      )
      .replace('import { client } from "virtual:oxide/client";\n', "")
      .replace("export const ticks", "const ticks")}\nexport default ticks;\n`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-stub-"));
    const stubFile = path.join(dir, "stub.mjs");
    // Inject client/wrappers as globals the stub closes over via import rewrite.
    fs.writeFileSync(
      stubFile,
      `const client = globalThis.__oxideStubClient;
const wrapClientRpc = globalThis.__oxideWrapClientRpc;
const wrapClientStreamRpc = globalThis.__oxideWrapClientStreamRpc;
${stubSource}`
    );
    // SAFETY: test harness globals for the generated stub module.
    const g = globalThis as typeof globalThis & {
      __oxideStubClient?: typeof client;
      __oxideWrapClientRpc?: typeof wrapClientRpc;
      __oxideWrapClientStreamRpc?: typeof wrapClientStreamRpc;
    };
    g.__oxideStubClient = client;
    g.__oxideWrapClientRpc = wrapClientRpc;
    g.__oxideWrapClientStreamRpc = wrapClientStreamRpc;
    try {
      const mod = await import(stubFile);
      // SAFETY: generated stub default export is the ticks client handle.
      const fn = mod.default as (
        ...args: (JsonValue | ClientStubOpts)[]
      ) => Promise<JsonValue | ClientStubOpts>;
      const ac = new AbortController();
      expect(await fn(10, { signal: ac.signal })).toBe(10);
      expect(await fn({ signal: ac.signal })).toEqual({ signal: ac.signal });
      expect(await fn({ n: 1 })).toEqual({ n: 1 });
      expect(await fn({ signal: "nope" })).toEqual({ signal: "nope" });
      expect(await fn(10, { extra: true, signal: ac.signal })).toBe(10);
      expect(seen).toEqual([
        { opts: { signal: ac.signal }, params: 10 },
        { params: { signal: ac.signal } },
        { params: { n: 1 } },
        { params: { signal: "nope" } },
        { opts: { extra: true, signal: ac.signal }, params: 10 },
      ]);
    } finally {
      delete g.__oxideStubClient;
      delete g.__oxideWrapClientRpc;
      delete g.__oxideWrapClientStreamRpc;
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  test("client actions module exposes RpcGroup only", () => {
    const code = generateActionsClientModule([
      {
        abs: "/app/src/test.server.ts",
        exports: ["ping"],
        key: "test",
        streams: [],
      },
      {
        abs: "/app/src/tasks.server.ts",
        exports: ["list"],
        key: "tasks",
        streams: ["list"],
      },
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
      {
        abs: "/app/src/test.server.ts",
        exports: ["ping"],
        key: "test",
        streams: [],
      },
    ]);
    expect(code).toContain('import * as __m0 from "/app/src/test.server.ts"');
    expect(code).toContain('Rpc.make("test.ping"');
    expect(code).toContain(
      'import { getRequestStore, withRequestStore } from "oxidejs"'
    );
    expect(code).toContain('"test.ping": ({ args }) => __run');
    expect(code).toContain("const __s = getRequestStore()");
    expect(code).toContain(".apply(null, args))");
    expect(code).not.toContain("AsyncLocalStorage");
    expect(code).not.toContain('"_action": {');
    expect(code).not.toContain("__args");
  });

  test("fetch wrapper tries server.ts then assets", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", {
      hasClient: true,
      preset: "fetch",
    });
    expect(code).toContain('export * from "/app/src/server.ts"');
    expect(code).toContain(
      'import user, { fetch as __namedFetch } from "/app/src/server.ts"'
    );
    expect(code).toContain(
      'import { actionsGroup, actionsHandlers } from "virtual:oxide/actions"'
    );
    expect(code).toContain(
      'p === "/__oxide/action" || p === "/__oxide/action/"'
    );
    expect(code).toContain("request[__fetch]");
    expect(code).toContain("await __userFetch(request, env ?? {}, ctx)");
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
    const code = generateWorkerWrapper("/app/src/server.ts", {
      preset: "fetch",
    });
    expect(code).not.toContain("node:fs/promises");
    expect(code).toContain("createServer");
    expect(code).toContain("__userFetch(request, env, ctx)");
    expect(code).not.toContain("__asset");
  });

  test("celld wrapper does not serve assets or listen", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", {
      preset: "celld",
    });
    expect(code).not.toContain("node:fs/promises");
    expect(code).not.toContain("createServer");
    expect(code).toContain(
      '__nf = () => new Response("<h1>404 Not Found</h1>", { status: 404'
    );
    expect(code).toContain("env?.ASSETS");
    expect(code).toContain("assets.fetch(request)");
    expect(code).toContain('oxidejs/worker-dom/install"');
    expect(code).not.toContain("ensureWorkerDom()");
    expect(code).not.toContain(": __nf()");
    expect(code).toContain("export * from");
    expect(code).toContain("...user");
  });

  test("fetch wrapper with public/ still serves assets", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", {
      hasPublic: true,
    });
    expect(code).toContain("node:fs/promises");
    expect(code).toContain("__nav(request)");
  });

  test("wrapper without actions skips RPC", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", {
      hasActions: false,
    });
    expect(code).not.toContain("oxidejs/rpc");
    expect(code).not.toContain("virtual:oxide/actions");
    expect(code).not.toContain("/__oxide/action");
    expect(code).toContain("__userFetch(request, env, ctx)");
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
    const code = generateWorkerWrapper("/app/src/server.ts", {
      hasClient: true,
      preset: "fetch",
    });
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

  test("generated __rel matches assetRelPath for all attack vectors", async () => {
    const code = generateWorkerWrapper("/app/src/server.ts", {
      hasClient: true,
      preset: "fetch",
    });
    // Extract the __rel function from generated code and evaluate it
    const match = code.match(
      /function __rel\(pathname, spa\) \{[\s\S]*?\n\}/u
    )?.[0];
    expect(match).toBeTruthy();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-rel-"));
    const file = path.join(dir, "rel.mjs");
    fs.writeFileSync(file, `${expectDefined(match)};\nexport default __rel;\n`);
    try {
      const mod = await import(file);
      // SAFETY: temp module default-exports the extracted __rel helper.
      const __rel = mod.default as (
        pathname: string,
        spa?: boolean
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
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  test("generated server uses req.url safely with URL constructor", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", {
      hasClient: true,
      preset: "fetch",
    });
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
        hasPublic: true,
        preset: "fetch",
      });
      // The asset block sits between the __assets const and the app object.
      const start = code.indexOf("const __assets");
      const end = code.indexOf("const app =");
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const assetBlock = code.slice(start, end);
      // Strip the import lines and the __assets const; we inject those via scope.
      const body = assetBlock
        .replaceAll(/^import .*\n/gmu, "")
        .replace(/^const __assets = .*;\n?/mu, "");
      const evalDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "oxide-asset-eval-")
      );
      const evalFile = path.join(evalDir, "assets.mjs");
      fs.writeFileSync(
        evalFile,
        `export default function create(readFile, extname, join, __assets) {
${body}
return { __rel, __asset };
}
`
      );
      try {
        const mod = await import(evalFile);
        // SAFETY: temp module default-exports the generated __rel/__asset factory.
        const factory = mod.default as (
          readFile: (p: string) => Promise<Buffer>,
          extname: typeof path.extname,
          join: typeof path.join,
          assets: string
        ) => {
          __rel: (pathname: string, spa?: boolean) => string | undefined;
          __asset: (
            request: Request,
            spa?: boolean
          ) => Promise<Response | undefined>;
        };
        const { __asset } = factory(
          (p: string) => import("node:fs/promises").then((m) => m.readFile(p)),
          path.extname,
          path.join,
          client
        );

        // Valid asset served with correct content-type
        const index = expectDefined(
          await __asset(new Request("http://x/index.html"))
        );
        expect(index.status).toBe(200);
        expect(await index.text()).toBe("<html>home</html>");
        expect(index.headers.get("content-type")).toBe(
          "text/html; charset=utf-8"
        );
        expect(index.headers.get("cache-control")).toBe("no-cache");

        // Binary asset keeps its bytes and gets the right type
        const png = expectDefined(
          await __asset(new Request("http://x/logo.png"))
        );
        expect(png.headers.get("content-type")).toBe("image/png");
        expect(Buffer.from(await png.arrayBuffer())).toEqual(
          Buffer.from([1, 2, 3, 4])
        );

        // Nested path
        const deep = expectDefined(
          await __asset(new Request("http://x/nested/deep.txt"))
        );
        expect(await deep.text()).toBe("deep-content");
        expect(deep.headers.get("content-type")).toBe(
          "application/octet-stream"
        );

        // Missing file → undefined (caller returns 404)
        expect(
          await __asset(new Request("http://x/missing.png"))
        ).toBeUndefined();

        // SPA fallback resolves unknown paths to index.html
        const spa = expectDefined(
          await __asset(new Request("http://x/some/route"), true)
        );
        expect(await spa.text()).toBe("<html>home</html>");

        // Traversal and double-slash are blocked at the __rel gate
        expect(
          await __asset(new Request("http://x/../secret.txt"))
        ).toBeUndefined();
        expect(
          await __asset(new Request("http://x/..%2fsecret.txt"))
        ).toBeUndefined();
        expect(
          await __asset(new Request("http://x//etc/passwd"))
        ).toBeUndefined();
        expect(
          await __asset(new Request("http://x/%2e%2e/secret.txt"))
        ).toBeUndefined();
        // SPA fallback maps traversal paths to index.html — never outside assets
        const spaTraversal = expectDefined(
          await __asset(new Request("http://x/../secret.txt"), true)
        );
        expect(await spaTraversal.text()).toBe("<html>home</html>");
      } finally {
        fs.rmSync(evalDir, { force: true, recursive: true });
      }
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("stubs client, not worker", () => {
    expect(shouldStubServerModule({ consumer: "client" })).toBe(true);
    expect(shouldStubServerModule({ consumer: "server" })).toBe(false);
    expect(shouldStubServerModule({ config: { consumer: "server" } })).toBe(
      false
    );
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
    expect(
      pluginShouldStub({ environment: { config: { consumer: "server" } } })
    ).toBe(false);
    expect(
      pluginShouldStub({ environment: { config: { consumer: "client" } } })
    ).toBe(true);
    expect(pluginShouldStub({}, { ssr: true })).toBe(false);
    expect(
      pluginShouldStub({
        getNativeBuildContext: () => ({
          compiler: { options: { target: "node" } },
        }),
      })
    ).toBe(false);
    expect(
      pluginShouldStub({
        getNativeBuildContext: () => ({ compiler: { name: "web" } }),
      })
    ).toBe(true);
  });

  test("client stub load never includes server source", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-stub-"));
    const file = path.join(root, "secret.server.ts");
    fs.writeFileSync(
      file,
      `const SECRET = "leak-me";\nexport const ping = action(async () => SECRET)\n`
    );
    try {
      const stub = loadClientStub(file);
      expect(stub).toContain('from "virtual:oxide/client"');
      expect(stub).toContain(
        'client["secret"]["ping"](...args.slice(0, -1), opts)'
      );
      expect(stub).not.toContain("leak-me");
      expect(stub).not.toContain("const SECRET");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
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
`
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      expect(await readRpcFrame(await rpcCall(fetch, "test.ping"))).toEqual({
        id: 1,
        jsonrpc: "2.0",
        result: "pong",
      });
      expect(
        await readRpcFrame(await rpcCall(fetch, "test.echo", ["hello"]))
      ).toEqual({
        id: 1,
        jsonrpc: "2.0",
        result: "hello",
      });
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("returning a Response from an action yields a clear error", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-rpc-resp-"));
    const file = path.join(root, "test.server.ts");
    const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
    fs.writeFileSync(
      file,
      `import { action } from ${ctx};\nexport const raw = action(() => new Response("RAW"))\n`
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      expect(
        await readRpcFrame(await rpcCall(fetch, "test.raw"))
      ).toMatchObject({
        error: { code: -32_603, message: "Internal error" },
        id: 1,
        jsonrpc: "2.0",
      });
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("accepts a trailing slash on the action path", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-rpc-slash-"));
    const file = path.join(root, "test.server.ts");
    const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
    fs.writeFileSync(
      file,
      `import { action } from ${ctx};\nexport const ping = action(async () => "pong")\n`
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const res = await fetch(
        new Request("http://localhost/__oxide/action/", {
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "test.ping",
            params: { args: [] },
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      );
      expect(res.status).toBe(200);
      expect(await readRpcFrame(res)).toEqual({
        id: 1,
        jsonrpc: "2.0",
        result: "pong",
      });
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("preserves a single array argument without unwrapping", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-rpc-nest-"));
    const file = path.join(root, "test.server.ts");
    const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
    fs.writeFileSync(
      file,
      `import { action } from ${ctx};\nexport const echo = action(async (value: string[]) => value)\n`
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const res = await fetch(
        new Request("http://localhost/__oxide/action/", {
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "test.echo",
            params: { args: [["hello"]] },
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      );
      expect(res.status).toBe(200);
      expect(await readRpcFrame(res)).toEqual({
        id: 1,
        jsonrpc: "2.0",
        result: ["hello"],
      });
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("void actions encode as null", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-void-"));
    const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
    fs.writeFileSync(
      path.join(root, "noop.server.ts"),
      `import { action } from ${ctx};
export const noop = action(async () => {})
`
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      expect(await readRpcFrame(await rpcCall(fetch, "noop.noop"))).toEqual({
        id: 1,
        jsonrpc: "2.0",
        result: null,
      });
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("streams async generators as chunked JSON-RPC", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-stream-"));
    const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
    fs.writeFileSync(
      path.join(root, "ticks.server.ts"),
      `import { action } from ${ctx};
export const ticks = action(async function* () { yield 0; yield 1; return 2 })
`
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const res = await rpcCall(fetch, "ticks.ticks");
      expect(res.headers.get("content-type")).toContain("application/json-rpc");
      const body = await readRpcFrames(res);
      expect(body).toEqual([
        { chunk: true, id: 1, jsonrpc: "2.0", result: [0] },
        { chunk: true, id: 1, jsonrpc: "2.0", result: [1] },
        { id: 1, jsonrpc: "2.0", result: null },
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("stream frames flush before the generator finishes", async () => {
    const root = fs.mkdtempSync(
      path.join(import.meta.dir, "oxide-stream-live-")
    );
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
`
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const res = await rpcCall(fetch, "ticks.ticks");
      expect(res.body).toBeTruthy();
      const reader = expectDefined(res.body).getReader();
      const decoder = new TextDecoder();
      const first = await readStreamUntilNewline(reader, decoder);
      const firstLine = expectDefined(first.buf.split("\n")[0]);
      expect(JSON.parse(firstLine)).toEqual({
        chunk: true,
        id: 1,
        jsonrpc: "2.0",
        result: [0],
      });

      // Second frame must not arrive until the gate opens.
      const second = reader.read();
      const premature = await Promise.race([
        second.then((chunk) => ({ chunk, kind: "frame" as const })),
        Bun.sleep(40).then(() => ({ kind: "timeout" as const })),
      ]);
      expect(premature.kind).toBe("timeout");

      fs.writeFileSync(gateFile, "go");
      const rest = premature.kind === "frame" ? premature.chunk : await second;
      const restStart = rest.value
        ? decoder.decode(rest.value, { stream: true })
        : "";
      const restRead = rest.done
        ? { buf: restStart, done: true }
        : await readStreamUntilNewline(reader, decoder, restStart);
      const restLine = expectDefined(
        restRead.buf.split("\n").find((line) => line.length > 0)
      );
      expect(JSON.parse(restLine)).toEqual({
        chunk: true,
        id: 1,
        jsonrpc: "2.0",
        result: [1],
      });
      await reader.cancel();
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("useRequest() works inside an async generator", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-gen-req-"));
    fs.writeFileSync(
      path.join(root, "who.server.ts"),
      `import { action, useRequest } from ${JSON.stringify(path.join(import.meta.dir, "context.ts"))};
export const who = action(async function* () { yield useRequest().headers.get("x-user") })
`
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const res = await rpcCall(fetch, "who.who", undefined, {
        headers: { "x-user": "ada" },
      });
      const body = await readRpcFrames(res);
      // SAFETY: first NDJSON frame is a JSON-RPC success/error object.
      const first = body[0] as { result?: JsonValue } | undefined;
      expect(first?.result).toEqual(["ada"]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("useRequest() stays available after a yield in an async generator", async () => {
    const root = fs.mkdtempSync(
      path.join(import.meta.dir, "oxide-gen-req-after-")
    );
    fs.writeFileSync(
      path.join(root, "who.server.ts"),
      `import { action, useRequest } from ${JSON.stringify(path.join(import.meta.dir, "context.ts"))};
export const who = action(async function* () {
  yield "start";
  yield useRequest().headers.get("x-user");
})
`
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const res = await rpcCall(fetch, "who.who", undefined, {
        headers: { "x-user": "ada" },
      });
      const body = await readRpcFrames(res);
      expect(body).toEqual([
        { chunk: true, id: 1, jsonrpc: "2.0", result: ["start"] },
        { chunk: true, id: 1, jsonrpc: "2.0", result: ["ada"] },
        { id: 1, jsonrpc: "2.0", result: null },
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("useRequest() reads the inbound Request inside an action", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-req-"));
    fs.writeFileSync(
      path.join(root, "who.server.ts"),
      `import { action, useRequest } from ${JSON.stringify(path.join(import.meta.dir, "context.ts"))};
export const who = action(async () => useRequest().headers.get("x-user"))
`
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const res = await rpcCall(fetch, "who.who", undefined, {
        headers: { "x-user": "ada" },
      });
      expect(await readRpcFrame(res)).toEqual({
        id: 1,
        jsonrpc: "2.0",
        result: "ada",
      });
      expect(() => useRequest()).toThrow("request context is unavailable");
      expect(() => useCtx()).toThrow("request context is unavailable");
      expect(() => useEnv()).toThrow("request context is unavailable");
      expect(() => useFetchCtx()).toThrow("request context is unavailable");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("action adds typed cancellation and Atom.fn-shaped handles", async () => {
    const ping = action(() => "pong" as const);
    const echo = action((value: string) => value);
    const { signal } = new AbortController();

    expect(ping.$$atom).toBe(1);
    expect(ping.set).toBeInstanceOf(Function);
    expect(ping.bind).toBeInstanceOf(Function);
    expect(await ping({ signal })).toBe("pong");
    expect(await echo("ok", { signal })).toBe("ok");
    expect(await ping.set()).toBe("pong");
  });

  test("runWithRequest always provides the current Request", () => {
    const controller = new AbortController();
    const request = new Request("http://localhost/frame", {
      signal: controller.signal,
    });

    runWithRequest(
      request,
      () => {
        expect(useRequest()).toBe(request);
        expect(useRequest().signal).toBe(controller.signal);
        expect(useEnv<{ TASKS: boolean }>()).toEqual({ TASKS: true });
      },
      { env: { TASKS: true }, req: new Request("http://wrong/") }
    );
  });

  test("WebContainer sync store survives await when ALS would be empty", async () => {
    __setInWebcontainerForTests(true);
    try {
      const request = new Request("http://localhost/wc");
      const seen = await runWithRequest(request, async () => {
        await Promise.resolve();
        return useRequest().url;
      });
      expect(seen).toBe("http://localhost/wc");
    } finally {
      __setInWebcontainerForTests(null);
    }
  });

  test("WebContainer withRequestStore reinstalls a captured store after the entry settles", async () => {
    __setInWebcontainerForTests(true);
    try {
      const request = new Request("http://localhost/capture");
      const captured = await runWithRequest(request, async () => {
        await Promise.resolve();
        return getRequestStore();
      });
      expect(() => getRequestStore()).toThrow("request context is unavailable");
      expect(withRequestStore(captured, () => useRequest())).toBe(request);
      expect(() => getRequestStore()).toThrow("request context is unavailable");
    } finally {
      __setInWebcontainerForTests(null);
    }
  });

  test("WebContainer withRequestStore restores sync store after sync throw", () => {
    __setInWebcontainerForTests(true);
    try {
      const request = new Request("http://localhost/throw");
      expect(() =>
        withRequestStore({ req: request }, () => {
          throw new Error("boom");
        })
      ).toThrow("boom");
      expect(() => getRequestStore()).toThrow("request context is unavailable");
    } finally {
      __setInWebcontainerForTests(null);
    }
  });

  test("WebContainer withRequestEntry serializes overlapping entries", async () => {
    __setInWebcontainerForTests(true);
    try {
      const order: string[] = [];
      const a = withRequestEntry(async () => {
        order.push("a-start");
        await Bun.sleep(20);
        order.push("a-end");
      });
      const b = withRequestEntry(() => {
        order.push("b-start", "b-end");
        return Promise.resolve();
      });
      await Promise.all([a, b]);
      expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
    } finally {
      __setInWebcontainerForTests(null);
    }
  });

  test("WebContainer unary action resolves useRequest after awaits", async () => {
    __setInWebcontainerForTests(true);
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-wc-"));
    fs.writeFileSync(
      path.join(root, "who.server.ts"),
      `import { action, useRequest } from ${JSON.stringify(OXIDE_RUNTIME)};
export const who = action(async () => {
  await Promise.resolve();
  return useRequest().url;
})
`
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const res = await rpcCall(fetch, "who.who");
      expect(await readRpcFrame(res)).toEqual({
        id: 1,
        jsonrpc: "2.0",
        result: "http://localhost/__oxide/action",
      });
    } finally {
      __setInWebcontainerForTests(null);
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("useEnv() and useFetchCtx() read RPC context extras", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-env-"));
    fs.writeFileSync(
      path.join(root, "who.server.ts"),
      `import { action, useCtx, useEnv, useFetchCtx } from ${JSON.stringify(path.join(import.meta.dir, "context.ts"))};
export const who = action(async () => {
  const env = useEnv();
  useFetchCtx()?.waitUntil?.(Promise.resolve(null));
  return { secret: env.SECRET, user: useCtx().user };
})
`
    );
    const out = writeActionsModule(
      root,
      generateActionsModule(scanServerFiles(root))
    );
    try {
      const mod = await import(out);
      const waited: Promise<unknown>[] = [];
      const fetch = createActionHandler(mod.default, mod.actionsHandlers, {
        createContext: () => ({
          env: { SECRET: "from-env" },
          fetchCtx: {
            waitUntil: (p) => {
              waited.push(Promise.resolve(p));
            },
          },
          req: new Request("http://localhost/__oxide/action"),
          user: "ada",
        }),
        path: "/__oxide/action",
        sameOrigin: false,
      });
      const res = await rpcCall(fetch, "who.who");
      expect(await readRpcFrame(res)).toEqual({
        id: 1,
        jsonrpc: "2.0",
        result: { secret: "from-env", user: "ada" },
      });
      expect(waited).toHaveLength(1);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
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
`
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const ac = new AbortController();
      const pending = rpcCall(fetch, "wait.wait", undefined, {
        signal: ac.signal,
      });
      await Promise.resolve();
      ac.abort();
      expect(await readRpcFrame(await pending)).toEqual({
        id: 1,
        jsonrpc: "2.0",
        result: "aborted",
      });
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("nodeToWebRequest abort follows IncomingMessage aborted", async () => {
    const { EventEmitter } = await import("node:events");
    // oxlint-disable-next-line unicorn/prefer-event-target -- IncomingMessage uses EventEmitter once/emit
    const req = Object.assign(new EventEmitter(), {
      aborted: false,
      destroyed: true,
      headers: { host: "localhost" },
      method: "GET",
      url: "/",
    });
    // SAFETY: minimal IncomingMessage stand-in for abort wiring.
    const request = await nodeToWebRequest(req as never);
    expect(request.signal.aborted).toBe(false);
    req.emit("close");
    expect(request.signal.aborted).toBe(false);
    req.emit("aborted");
    expect(request.signal.aborted).toBe(true);
  });

  test("nodeToWebRequest enforces the body limit", async () => {
    const { EventEmitter } = await import("node:events");
    // oxlint-disable-next-line unicorn/prefer-event-target -- IncomingMessage uses EventEmitter once/emit
    const req = Object.assign(new EventEmitter(), {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("too large");
      },
      headers: { host: "localhost" },
      method: "POST",
      url: "/__oxide/action",
    });
    // SAFETY: minimal IncomingMessage stand-in for body-limit checks.
    await expect(nodeToWebRequest(req as never, 3)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError
    );
  });

  test("nodeToWebRequest stays open after draining a POST body", async () => {
    const { EventEmitter } = await import("node:events");
    const chunks = [Buffer.from('{"jsonrpc":"2.0"}')];
    // oxlint-disable-next-line unicorn/prefer-event-target -- IncomingMessage uses EventEmitter once/emit
    const req = Object.assign(new EventEmitter(), {
      async *[Symbol.asyncIterator]() {
        yield* chunks;
      },
      destroyed: true,
      headers: { host: "localhost" },
      method: "POST",
      url: "/__oxide/action",
    });
    // SAFETY: minimal IncomingMessage stand-in for POST body drain.
    const request = await nodeToWebRequest(req as never);
    expect(request.signal.aborted).toBe(false);
    expect(await request.text()).toBe('{"jsonrpc":"2.0"}');
  });

  test("/__oxide/action is POST-only and rejects unknown methods", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-wire-"));
    const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
    fs.writeFileSync(
      path.join(root, "test.server.ts"),
      `import { action } from ${ctx};\nexport const ping = action(async () => "pong")\n`
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const get = await fetch(new Request("http://localhost/__oxide/action"));
      expect(get.status).toBe(405);
      expect(get.headers.get("allow")).toBe("POST");
      const miss = await fetch(
        new Request("http://localhost/__oxide/action", {
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "test.secret",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      );
      expect(await readRpcFrame(miss)).toEqual({
        error: { code: -32_601, message: "Method not found" },
        id: 1,
        jsonrpc: "2.0",
      });
      const proto = await fetch(
        new Request("http://localhost/__oxide/action", {
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "__proto__.ping",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      );
      expect(await readRpcFrame(proto)).toEqual({
        error: { code: -32_601, message: "Method not found" },
        id: 1,
        jsonrpc: "2.0",
      });
      const other = await fetch(
        new Request("http://localhost/api", {
          body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "test.ping" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      );
      expect(other.status).toBe(404);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("invalid params are rejected", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-params-"));
    const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
    fs.writeFileSync(
      path.join(root, "test.server.ts"),
      `import { action } from ${ctx};\nexport const echo = action(async (value) => value ?? "empty")\n`
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const call = (params: JsonValue) =>
        fetch(
          new Request("http://localhost/__oxide/action", {
            body: JSON.stringify({
              id: 1,
              jsonrpc: "2.0",
              method: "test.echo",
              params,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          })
        ).then((res) => readRpcFrame(res));
      expect(await call({ 0: "sneak" })).toEqual({
        error: { code: -32_602, message: "Invalid params" },
        id: 1,
        jsonrpc: "2.0",
      });
      expect(await call({ args: ["ok"] })).toEqual({
        id: 1,
        jsonrpc: "2.0",
        result: "ok",
      });
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("thrown errors scrub Defect payloads (no message leak)", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-scrub-"));
    const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
    fs.writeFileSync(
      path.join(root, "test.server.ts"),
      `import { action } from ${ctx};\nexport const boom = action(async () => { throw new Error("secret-leak-check"); })\n`
    );
    try {
      const fetch = await loadGeneratedRouter(root);
      const res = await rpcCall(fetch, "test.boom");
      const body = await readRpcFrame(res);
      expect(body).toEqual({
        error: { code: -32_603, message: "Internal error" },
        id: 1,
        jsonrpc: "2.0",
      });
      expect(JSON.stringify(body)).not.toContain("secret-leak-check");
      expect(JSON.stringify(body)).not.toContain("Defect");
      expect(JSON.stringify(body)).not.toContain("_tag");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
