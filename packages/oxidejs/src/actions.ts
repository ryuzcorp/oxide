import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { OxidejsPreset } from "./types";

export const VIRTUAL_ACTIONS_ID = "virtual:oxide/actions";
export const RESOLVED_VIRTUAL_ACTIONS_ID = `\0${VIRTUAL_ACTIONS_ID}`;
export const VIRTUAL_WORKER_ID = "virtual:oxide/worker";
export const RESOLVED_VIRTUAL_WORKER_ID = `\0${VIRTUAL_WORKER_ID}`;
export const ACTION_PATH = "/_action";

const IGNORE_DIRS = new Set(["node_modules", "dist", ".git", ".wrangler"]);
const EXPORT_RE =
  /^\s*export\s+(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)|^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*=/gm;

export interface ServerModule {
  abs: string;
  key: string;
  exports: string[];
}

export function isServerFileId(id: string): boolean {
  const file = id.split("?")[0]?.replace(/\\/g, "/") ?? "";
  return file.endsWith(".server.ts") || file.endsWith(".server.js");
}

export function moduleKey(absFile: string): string {
  return path.basename(absFile).replace(/\.server\.(ts|js)$/i, "");
}

export function parseExportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(EXPORT_RE)) {
    const name = match[1] ?? match[2];
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

export function generateClientStub(mod: Pick<ServerModule, "key" | "exports">): string {
  const lines = [
    `import { createClient } from "tacho/client/http";`,
    `const __rpc = createClient({ url: ${JSON.stringify(ACTION_PATH)} });`,
  ];
  for (const name of mod.exports) {
    lines.push(
      `export const ${name} = (...args) => __rpc[${JSON.stringify(mod.key)}][${JSON.stringify(name)}](args);`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function generateActionsModule(modules: ServerModule[]): string {
  const lines = [`import { tacho } from "tacho";`];
  const aliases = modules.map((mod, i) => {
    const alias = `__m${i}`;
    lines.push(`import * as ${alias} from ${JSON.stringify(mod.abs)};`);
    return { alias, mod };
  });
  lines.push(`const rpc = tacho();`);
  lines.push(`const actions = rpc({`);
  for (const { alias, mod } of aliases) {
    lines.push(`  ${JSON.stringify(mod.key)}: {`);
    for (const name of mod.exports) {
      lines.push(
        `    ${JSON.stringify(name)}: rpc.run(({ input }) => ${alias}[${JSON.stringify(name)}].apply(null, Array.isArray(input) ? input : [])),`,
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
    req.once("close", abort);
    const pull = (): void => {
      reader.read().then(({ done, value }) => {
        if (done) {
          req.off("close", abort);
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
  opts: { preset?: OxidejsPreset; clientDir?: string; hasClient?: boolean } = {},
): string {
  const preset = opts.preset ?? "fetch";
  const clientDir = opts.clientDir ?? "client";
  const serveAssets = preset === "fetch" && opts.hasClient === true;
  const assetBlock = serveAssets
    ? `import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
const __assets = join(import.meta.dirname, ${JSON.stringify(clientDir)});
const __types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
async function __asset(request, spa) {
  let file = new URL(request.url).pathname;
  if (file === "/" || spa) file = "/index.html";
  try {
    const body = await readFile(join(__assets, file));
    return new Response(body, { headers: { "content-type": __types[extname(file)] ?? "application/octet-stream" } });
  } catch {
    return;
  }
}
`
    : "";
  const afterAction = serveAssets
    ? `if (typeof user.fetch === "function") {
      const hit = await user.fetch(request, env, ctx);
      if (hit) return hit;
    }
    return (await __asset(request)) ?? (await __asset(request, true)) ?? new Response("Not Found", { status: 404 });`
    : `return typeof user.fetch === "function"
      ? user.fetch(request, env, ctx)
      : new Response("Not Found", { status: 404 });`;
  const listen =
    preset === "fetch"
      ? `
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3000;
  createServer(async (req, res) => {
    const url = \`http://\${req.headers.host ?? "localhost"}\${req.url ?? "/"}\`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      else headers.set(key, value);
    }
    const method = req.method ?? "GET";
    const chunks = [];
    if (method !== "GET" && method !== "HEAD") for await (const chunk of req) chunks.push(chunk);
    const init = { method, headers };
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
  }).listen(port, () => console.log(\`oxidejs listening on \${port}\`));
}
`
      : "";
  return `export * from ${JSON.stringify(userWorkerAbs)};
import user from ${JSON.stringify(userWorkerAbs)};
import { handle } from "tacho/transport/fetch";
import actions from ${JSON.stringify(VIRTUAL_ACTIONS_ID)};
${assetBlock}const __rpc = handle(actions, { path: ${JSON.stringify(ACTION_PATH)} });
const app = {
  ...user,
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === ${JSON.stringify(ACTION_PATH)}) return __rpc(request);
    ${afterAction}
  },
};
export default app;
${listen}`;
}

export function shouldStubServerModule(environment?: {
  name?: string;
  consumer?: string;
}): boolean {
  if (environment?.consumer === "server") return false;
  if (environment?.name && environment.name !== "client") return false;
  return true;
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
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const body = Buffer.concat(chunks);
  const init: RequestInit = { method, headers };
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
