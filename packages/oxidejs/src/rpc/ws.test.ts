import { expect, test } from "bun:test";
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

test("WebSocket answers effect keepalive pings without touching the action handler", async () => {
  const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-ws-ping-"));
  const ctx = JSON.stringify(path.join(import.meta.dir, "../context.ts"));
  fs.writeFileSync(
    path.join(root, "noop.server.ts"),
    `import { action } from ${ctx};
export const boom = action(() => {
  throw new Error("ping must not reach the action handler");
})
`,
  );
  const out = writeGeneratedActions(root);

  try {
    const mod = await import(out);
    const hooks = createWsHooks(mod.default, mod.actionsHandlers, {
      path: "/__oxide/action",
      sameOrigin: false,
    });
    const sent: string[] = [];
    const peer = {
      request: new Request("http://localhost/__oxide/action"),
      context: {},
      send: (data: unknown) => sent.push(String(data)),
    };
    await hooks.message(peer, {
      text: () => JSON.stringify({ jsonrpc: "2.0", method: "@effect/rpc/Ping" }),
    });
    expect(sent).toEqual([JSON.stringify({ jsonrpc: "2.0", method: "@effect/rpc/Pong" })]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("WebSocket stream sends NDJSON frames before the generator finishes", async () => {
  const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-ws-live-"));
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

  try {
    const mod = await import(out);
    const hooks = createWsHooks(mod.default, mod.actionsHandlers, {
      path: "/__oxide/action",
      sameOrigin: false,
      createContext: () =>
        ({
          req: new Request("http://localhost/__oxide/action"),
          marker: "from-peer",
        }) as import("../context").ActionContext,
    });
    const sent: string[] = [];
    const peer = {
      request: new Request("http://localhost/__oxide/action", {
        headers: { origin: "http://localhost", host: "localhost" },
      }),
      context: {},
      send: (data: unknown) => {
        sent.push(String(data));
      },
    };

    const pending = hooks.message(peer, {
      text: () =>
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "ticks.ticks",
          params: { args: [] },
        }),
    });

    const started = Date.now();
    while (sent.length === 0 && Date.now() - started < 5000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    if (sent.length === 0) {
      throw new Error("timed out waiting for first WebSocket NDJSON frame");
    }
    expect(sent.length).toBe(1);
    expect(JSON.parse(sent[0]!.trim())).toEqual({
      jsonrpc: "2.0",
      chunk: true,
      id: 1,
      result: [0],
    });

    fs.writeFileSync(gateFile, "go");
    await pending;
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(sent[1]!.trim())).toEqual({
      jsonrpc: "2.0",
      chunk: true,
      id: 1,
      result: [1],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
