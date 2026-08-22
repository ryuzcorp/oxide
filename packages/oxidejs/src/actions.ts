import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { OxidejsActionHeaders, OxidejsActionTransport, OxidejsPreset } from "./types";

export const VIRTUAL_ACTIONS_ID = "virtual:oxide/actions";
export const RESOLVED_VIRTUAL_ACTIONS_ID = `\0${VIRTUAL_ACTIONS_ID}`;
export const VIRTUAL_WORKER_ID = "virtual:oxide/worker";
export const RESOLVED_VIRTUAL_WORKER_ID = `\0${VIRTUAL_WORKER_ID}`;
export const VIRTUAL_CLIENT_ID = "virtual:oxide/client";
export const RESOLVED_VIRTUAL_CLIENT_ID = `\0${VIRTUAL_CLIENT_ID}`;
export const ACTION_PATH = "/__oxide/action";

const IGNORE_DIRS = new Set(["node_modules", "dist", ".git", ".wrangler"]);
/** Only `export const name = action(...)` become remote RPC actions. Everything else stays server-local. */
const EXPORT_RE = /^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?action\s*\(/gm;

export interface ServerModule {
  abs: string;
  key: string;
  exports: string[];
}

export function isServerFileId(id: string): boolean {
  const file = id.split("?")[0]?.replace(/\\/g, "/") ?? "";
  return [".ts", ".tsx", ".js", ".jsx"].some((ext) => file.endsWith(`.server${ext}`));
}

export function moduleKey(absFile: string): string {
  return path.basename(absFile).replace(/\.server\.(?:[jt]sx?)$/i, "");
}

export function parseExportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(EXPORT_RE)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return [...names];
}

export function scanServerFiles(root: string): ServerModule[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (entry.isFile() && isServerFileId(entry.name)) files.push(abs);
    }
  };
  walk(root);

  const byKey = new Map<string, string>();
  const modules: ServerModule[] = [];
  for (const abs of files.sort()) {
    const key = moduleKey(abs);
    if (!key) {
      throw new Error(`oxidejs: invalid server module name: ${abs}`);
    }
    const existing = byKey.get(key);
    if (existing) {
      throw new Error(`oxidejs: duplicate server module key "${key}": ${existing} and ${abs}`);
    }
    byKey.set(key, abs);
    modules.push({
      abs,
      key,
      exports: parseExportedNames(fs.readFileSync(abs, "utf8")),
    });
  }
  return modules;
}

/** Path under the asset root, or null if the URL must not be served. */
export function assetRelPath(pathname: string, spa = false): string | null {
  if (pathname.includes("\0")) return null;
  let file: string;
  try {
    file = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (file.includes("\0")) return null;
  if (file === "/" || spa) file = "/index.html";
  if (!file.startsWith("/") || file.split("/").includes("..")) return null;
  const rel = file.slice(1);
  if (rel.startsWith("/")) return null;
  return rel;
}

export function generateClientModule(
  transport: OxidejsActionTransport = "http",
  headers?: OxidejsActionHeaders,
  path: string = ACTION_PATH,
): string {
  if (transport === "ws") {
    return `import { createClient } from "tacho/client/ws";
const __proto = typeof location === "undefined" ? "ws:" : location.protocol === "https:" ? "wss:" : "ws:";
const __host = typeof location === "undefined" ? "localhost" : location.host;
export const client = createClient({ url: __proto + "//" + __host + ${JSON.stringify(path)} });
`;
  }
  const opts: { url: string; headers?: OxidejsActionHeaders } = { url: path };
  if (headers) opts.headers = headers;
  return `import { createClient } from "tacho/client/http";
export const client = createClient(${JSON.stringify(opts)});
`;
}

export function generateClientStub(mod: Pick<ServerModule, "key" | "exports">): string {
  const lines = [
    `// oxidejs:client-stub`,
    `import { client } from ${JSON.stringify(VIRTUAL_CLIENT_ID)};`,
  ];
  for (const name of mod.exports) {
    lines.push(
      `export const ${name} = (...args) => {
  const opts = args.at(-1);
  // ponytail: peel last { signal } only. A lone payload { signal: AbortSignal } is treated as CallOptions.
  return opts && typeof opts === "object" && opts.signal instanceof AbortSignal && Object.keys(opts).length === 1
    ? client[${JSON.stringify(mod.key)}][${JSON.stringify(name)}](args.slice(0, -1), opts)
    : client[${JSON.stringify(mod.key)}][${JSON.stringify(name)}](args);
};`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function generateActionsModule(modules: ServerModule[], opts?: { bust?: boolean }): string {
  const lines = [
    `import { AsyncLocalStorage } from "node:async_hooks";`,
    `import { tacho } from "tacho";`,
    `const __alsKey = Symbol.for("oxidejs.requestContext");`,
    `const __als = globalThis[__alsKey] ??= new AsyncLocalStorage();`,
  ];
  const aliases = modules.map((mod, i) => {
    const alias = `__m${i}`;
    const spec = opts?.bust === true ? `${mod.abs}?t=${fs.statSync(mod.abs).mtimeMs}` : mod.abs;
    lines.push(`import * as ${alias} from ${JSON.stringify(spec)};`);
    return { alias, mod };
  });
  lines.push(`const rpc = tacho();`);
  lines.push(`const actions = rpc({`);
  for (const { alias, mod } of aliases) {
    lines.push(`  ${JSON.stringify(mod.key)}: {`);
    for (const name of mod.exports) {
      lines.push(
        `    ${JSON.stringify(name)}: rpc.run(({ input, ctx }) => __als.run(ctx, () => {
      const out = ${alias}[${JSON.stringify(name)}].apply(null, Array.isArray(input) ? input : []);
      if (!out || typeof out !== "object" || typeof out.next !== "function") return out;
      return {
        next: (v) => __als.run(ctx, () => out.next(v)),
        return: (v) => __als.run(ctx, () => out.return(v)),
        throw: (e) => __als.run(ctx, () => out.throw(e)),
        [Symbol.asyncIterator]() { return this; },
      };
    })),`,
      );
    }
    lines.push(`  },`);
  }
  lines.push(`});`);
  lines.push(`export default actions;`);
  lines.push(`export { actions };`);
  return `${lines.join("\n")}\n`;
}

function pipeResponse(
  req: IncomingMessage,
  res: ServerResponse,
  response: Response,
): Promise<void> {
  return new Promise((resolve, reject) => {
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    if (!response.body) {
      res.end();
      resolve();
      return;
    }
    const reader = response.body.getReader();
    const abort = () => {
      void reader.cancel();
    };
    req.once("aborted", abort);
    const pull = (): void => {
      reader.read().then(({ done, value }) => {
        if (done) {
          req.off("aborted", abort);
          res.end();
          resolve();
          return;
        }
        if (value) res.write(value);
        pull();
      }, reject);
    };
    pull();
  });
}

export function generateWorkerWrapper(
  userWorkerAbs: string,
  opts: {
    preset?: OxidejsPreset;
    clientDir?: string;
    hasClient?: boolean;
    hasPublic?: boolean;
    hasActions?: boolean;
    actions?: OxidejsActionTransport;
    actionPath?: string;
    actionSameOrigin?: boolean;
    middleware?: (string | { module: string; imports?: string[] })[];
    imports?: string[];
    bodyLimit?: number;
    notFound?: string | undefined;
    env?: Record<string, unknown> | undefined;
  } = {},
): string {
  const preset = opts.preset ?? "fetch";
  const clientDir = opts.clientDir ?? "client";
  const actionPath = opts.actionPath ?? ACTION_PATH;
  const sameOrigin = opts.actionSameOrigin ?? false;
  const serveAssets = preset === "fetch" && (opts.hasClient === true || opts.hasPublic === true);
  const hasActions = opts.hasActions !== false;
  const ws = hasActions && opts.actions === "ws";
  const bodyLimit = opts.bodyLimit ?? 1048576;
  const nfBody = JSON.stringify(opts.notFound ?? "<h1>404 Not Found</h1>");
  const __nf = `() => new Response(${nfBody}, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } })`;
  const assetBlock = serveAssets
    ? `import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
const __assets = join(import.meta.dirname, ${JSON.stringify(clientDir)});
const __types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".webp": "image/webp" };
function __nav(request) {
  const dest = request.headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  return (request.headers.get("accept") ?? "").includes("text/html");
}
function __cache(file) {
  if (file === "index.html") return "no-cache";
  return /[-.][0-9a-f]{8,}.[a-z0-9]+$/i.test(file) ? "public, max-age=31536000, immutable" : undefined;
}
function __rel(pathname, spa) {
  if (pathname.includes("\0")) return;
  let file;
  try { file = decodeURIComponent(pathname); } catch { return; }
  if (file.includes("\0")) return;
  if (file === "/" || spa) file = "/index.html";
  if (!file.startsWith("/") || file.split("/").includes("..")) return;
  const rel = file.slice(1);
  if (rel.startsWith("/")) return;
  return rel;
}
async function __asset(request, spa) {
  const file = __rel(new URL(request.url).pathname, spa);
  if (!file) return;
  try {
    const body = await readFile(join(__assets, file));
    const headers = { "content-type": __types[extname(file)] ?? "application/octet-stream" };
    const cache = __cache(file);
    if (cache) headers["cache-control"] = cache;
    const etag = '"' + body.length.toString(16) + "-" + file + '"';
    headers["etag"] = etag;
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(body, { headers });
  } catch {
    return;
  }
}
const __nf = ${__nf};
`
    : "";
  void __nf; // referenced by name inside the generated wrapper source
  const envJson = JSON.stringify(opts.env ?? {});
  const afterAction = serveAssets
    ? `if (typeof user.fetch === "function") {
      const hit = await user.fetch(request, env ?? ${envJson}, ctx);
      if (hit) return hit;
    }
    return (await __asset(request)) ?? (__nav(request) ? await __asset(request, true) : undefined) ?? __nf();`
    : `return typeof user.fetch === "function"
      ? user.fetch(request, env, ctx)
      : __nf();`;
  const listen =
    preset === "fetch"
      ? `
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3000;
  const bodyLimit = ${bodyLimit};
  const server = createServer(async (req, res) => {
    const url = \`http://\${req.headers.host ?? "localhost"}\${req.url ?? "/"}\`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      else headers.set(key, value);
    }
    const ac = new AbortController();
    req.once("aborted", () => ac.abort());
    const method = req.method ?? "GET";
    const chunks = [];
    let size = 0;
    if (method !== "GET" && method !== "HEAD") for await (const chunk of req) {
      size += chunk.length;
      // Bound request buffering — unbounded bodies are a memory DoS vector.
      if (size > ${bodyLimit}) { res.statusCode = 413; res.end(); return; }
      chunks.push(chunk);
    }
    const init = { method, headers, signal: ac.signal };
    if (chunks.length) init.body = Buffer.concat(chunks);
    const response = await app.fetch(new Request(url, init));
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (!response.body) { res.end(); return; }
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(value);
    }
    res.end();
  });${
    ws
      ? `
  import("crossws/adapters/node").then(({ default: crossws }) => {
    const ws = crossws({ hooks: __ws });
    server.on("upgrade", (req, socket, head) => {
      if (req.url?.split("?")[0] === ${JSON.stringify(actionPath)}) ws.handleUpgrade(req, socket, head);
    });
  });`
      : ""
  }
  server.listen(port, () => console.log(\`oxidejs listening on \${port}\`));
}
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
`
      : "";
  const actionImports = hasActions
    ? ws
      ? `import { handle as handleWs } from "tacho/transport/ws";
import actions from ${JSON.stringify(VIRTUAL_ACTIONS_ID)};
const __ws = handleWs(actions, { path: ${JSON.stringify(actionPath)}${sameOrigin ? `, sameOrigin: true` : ``} });
`
      : `import { handle } from "tacho/transport/fetch";
import actions from ${JSON.stringify(VIRTUAL_ACTIONS_ID)};
const __fetch = Symbol.for("oxidejs.fetch");
const __rpc = handle(actions, { path: ${JSON.stringify(actionPath)}${sameOrigin ? `, sameOrigin: true` : ``}, createContext: (req) => req[__fetch] ?? {} });
`
    : "";
  const actionGate =
    hasActions && !ws
      ? `if (new URL(request.url).pathname === ${JSON.stringify(actionPath)}) {
      request[__fetch] = { env, fetchCtx: ctx };
      return __rpc(request);
    }
    `
      : "";
  // Convention: the ilha SSR middleware needs its server route graph loaded
  // before it runs; inject its known side-effect specifiers automatically.
  const ILHA_SSR_IMPLICIT = ["ilha:pages/server", "ilha:loaders"];
  const mwEntries = (opts.middleware ?? []).map((m) =>
    typeof m === "string"
      ? {
          module: m,
          imports: m === "@ilha/router/ssr" ? ILHA_SSR_IMPLICIT : ([] as string[]),
        }
      : m,
  );
  const middlewareImports =
    mwEntries
      .map(
        (m, i) =>
          (m.imports ?? []).map((spec) => `import ${JSON.stringify(spec)};`).join("\n") +
          `\nimport __mw${i} from ${JSON.stringify(m.module)};`,
      )
      .join("\n") + "\n";
  const middlewareList = (opts.middleware ?? []).map((_, i) => `__mw${i}`).join(", ");
  const middlewareGate = opts.middleware?.length
    ? `for (const __mw of [${middlewareList}]) {
      const hit = await __mw(request, { env, ctx });
      if (hit) return hit;
    }
    `
    : "";
  const sideEffectImports = (opts.imports ?? [])
    .map((spec) => `import ${JSON.stringify(spec)};`)
    .join("\n");
  return `${sideEffectImports}export * from ${JSON.stringify(userWorkerAbs)};
import user from ${JSON.stringify(userWorkerAbs)};
${middlewareImports}${actionImports}${assetBlock}const app = {
  ...user,
  async fetch(request, env, ctx) {
    ${middlewareGate}${actionGate}${afterAction}
  },
};
export default app;
${listen}`;
}

export type StubEnvironment = {
  name?: string;
  consumer?: string;
  config?: { consumer?: string };
};

export type StubExtra = {
  ssr?: boolean;
  target?: string | string[];
};

const SERVER_TARGETS = new Set(["node", "async-node", "webworker", "web-worker"]);
const CLIENT_TARGETS = new Set(["web", "browserslist"]);
const SERVER_NAMES = new Set(["server", "ssr", "worker", "node"]);
const CLIENT_NAMES = new Set(["client", "web"]);

/** Stub unless the graph is a known server. Unknown graphs stub so *.server.ts never ships. */
export function shouldStubServerModule(environment?: StubEnvironment, extra?: StubExtra): boolean {
  if (extra?.ssr) return false;

  const consumer = environment?.config?.consumer ?? environment?.consumer;
  if (consumer === "server") return false;
  if (consumer === "client") return true;

  const name = environment?.name;
  if (name && CLIENT_NAMES.has(name)) return true;
  if (name && SERVER_NAMES.has(name)) return false;

  const targets = extra?.target == null ? [] : [extra.target].flat();
  if (targets.some((target) => SERVER_TARGETS.has(target))) return false;
  if (targets.some((target) => CLIENT_TARGETS.has(target))) return true;

  return true;
}

export function pluginShouldStub(pluginThis: object, options?: { ssr?: boolean }): boolean {
  const ctx = pluginThis as {
    environment?: StubEnvironment;
    getNativeBuildContext?: () => {
      compiler?: { name?: string; options?: { name?: string; target?: string | string[] } };
    };
  };
  const compiler = ctx.getNativeBuildContext?.()?.compiler;
  const env: StubEnvironment = {};
  const name = ctx.environment?.name ?? compiler?.name ?? compiler?.options?.name;
  if (name) env.name = name;
  if (ctx.environment?.consumer) env.consumer = ctx.environment.consumer;
  if (ctx.environment?.config) env.config = ctx.environment.config;
  const extra: StubExtra = {};
  if (options?.ssr) extra.ssr = true;
  if (compiler?.options?.target) extra.target = compiler.options.target;
  return shouldStubServerModule(env, extra);
}

export function loadClientStub(id: string): string {
  const file = id.split("?")[0] ?? id;
  return generateClientStub({
    key: moduleKey(file),
    exports: parseExportedNames(fs.readFileSync(file, "utf8")),
  });
}

export async function nodeToWebRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? "localhost";
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  const ac = new AbortController();
  req.once("aborted", () => ac.abort());
  const method = req.method ?? "GET";
  const init: RequestInit = { method, headers, signal: ac.signal };
  if (method === "GET" || method === "HEAD") return new Request(url, init);
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const body = Buffer.concat(chunks);
  if (body.length > 0) init.body = body;
  return new Request(url, init);
}

export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  return pipeResponse({} as IncomingMessage, res, response);
}

export async function sendWebResponseFrom(
  req: IncomingMessage,
  res: ServerResponse,
  response: Response,
): Promise<void> {
  return pipeResponse(req, res, response);
}
