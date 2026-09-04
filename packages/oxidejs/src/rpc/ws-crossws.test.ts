import { expect, test } from "bun:test";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { generateActionsModule, scanServerFiles } from "../actions";
import { createWsHooks } from "./ws";

const RPC_MODULE = path.join(import.meta.dir, "index.ts");
const OXIDE_RUNTIME = path.join(import.meta.dir, "../context.ts");

function writeGeneratedActions(root: string) {
  const out = path.join(root, "actions.mjs");
  fs.writeFileSync(
    out,
    generateActionsModule(scanServerFiles(root))
      .replaceAll("oxidejs/rpc", RPC_MODULE)
      .replaceAll('from "oxidejs"', `from ${JSON.stringify(OXIDE_RUNTIME)}`),
  );
  return out;
}

test("createClient over ws transport resolves calls through a real socket", async () => {
  // Regression: loadClient used to build the protocol layer in a transient
  // scope, killing the socket read loop before it dialed — every call hung.
  const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-ws-client-"));
  const ctx = JSON.stringify(path.join(import.meta.dir, "../context.ts"));
  fs.writeFileSync(
    path.join(root, "hello.server.ts"),
    `import { action } from ${ctx};
export const hello = action(async (name: string) => ` +
      "`hi ${name}`" +
      `)
`,
  );
  const out = writeGeneratedActions(root);

  const server = http.createServer();
  const { default: crossws } = await import("crossws/adapters/node");
  const mod = await import(out);
  // SAFETY: crossws hook types are structurally looser than ours (see plugin.ts).
  const wss = crossws({
    hooks: createWsHooks(mod.default as never, mod.actionsHandlers as never, {
      path: "/__oxide/action",
      sameOrigin: false,
    }) as never,
  });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket as never, head);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });

  const { createClient } = await import("./client");
  const client = createClient(mod.default, {
    transport: "ws",
    url: `ws://127.0.0.1:${port}/__oxide/action`,
  });
  try {
    const result = await Promise.race([
      (client as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>)[
        "hello"
      ]!["hello"]!("Regression"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("ws client call timed out")), 5000),
      ),
    ]);
    expect(result).toBe("hi Regression");
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("createWsHooks works end-to-end over a real crossws WebSocket", async () => {
  const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-ws-crossws-"));
  const ctx = JSON.stringify(path.join(import.meta.dir, "../context.ts"));
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
  const out = writeGeneratedActions(root);

  const mod = await import(out);
  const server = http.createServer();
  const { default: crossws } = await import("crossws/adapters/node");
  // Same cast shape as plugin.ts: crossws' hook types are structurally looser than ours.
  const wss = crossws({
    hooks: createWsHooks(mod.default as never, mod.actionsHandlers as never, {
      path: "/__oxide/action",
      sameOrigin: false,
      createContext: () =>
        ({
          req: new Request("http://localhost/__oxide/action"),
          marker: "from-peer",
        }) as import("../context").ActionContext,
    }) as never,
  });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket as never, head);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });

  const frames: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/__oxide/action`);
  ws.onmessage = (event) => frames.push(String(event.data));

  const openPromise = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WebSocket failed to open"));
  });
  await openPromise;

  try {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ticks.ticks", params: { args: [] } }));

    const started = Date.now();
    while (frames.length === 0 && Date.now() - started < 5000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    if (frames.length === 0) {
      throw new Error("timed out waiting for first WebSocket NDJSON frame");
    }
    expect(frames.length).toBe(1);
    expect(JSON.parse(frames[0]!.trim())).toEqual({
      jsonrpc: "2.0",
      chunk: true,
      id: 1,
      result: [0],
    });

    fs.writeFileSync(gateFile, "go");
    while (frames.length < 2 && Date.now() - started < 5000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(frames[1]!.trim())).toEqual({
      jsonrpc: "2.0",
      chunk: true,
      id: 1,
      result: [1],
    });
  } finally {
    ws.close();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
