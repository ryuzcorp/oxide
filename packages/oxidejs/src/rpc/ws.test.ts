import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import type { ActionContext } from "../context";
import { waitUntil, writeGeneratedActions } from "./test-harness";
import { createWsHooks } from "./ws";

test("WebSocket answers effect keepalive pings without touching the action handler", async () => {
  const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-ws-ping-"));
  const ctx = JSON.stringify(path.join(import.meta.dir, "../context.ts"));
  fs.writeFileSync(
    path.join(root, "noop.server.ts"),
    `import { action } from ${ctx};
export const boom = action(() => {
  throw new Error("ping must not reach the action handler");
})
`
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
      context: {},
      request: new Request("http://localhost/__oxide/action"),
      send: (data: string) => {
        sent.push(data);
      },
    };
    await hooks.message(peer, {
      text: () =>
        JSON.stringify({ jsonrpc: "2.0", method: "@effect/rpc/Ping" }),
    });
    expect(sent).toEqual([
      JSON.stringify({ jsonrpc: "2.0", method: "@effect/rpc/Pong" }),
    ]);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
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
    await Bun.sleep(5);
  }
  yield 1;
})
`
  );
  const out = writeGeneratedActions(root);

  try {
    const mod = await import(out);
    const hooks = createWsHooks(mod.default, mod.actionsHandlers, {
      createContext: () =>
        // SAFETY: test peer context only needs req + a marker field for this assertion.
        ({
          marker: "from-peer",
          req: new Request("http://localhost/__oxide/action"),
        }) as ActionContext,
      path: "/__oxide/action",
      sameOrigin: false,
    });
    const sent: string[] = [];
    const peer = {
      context: {},
      request: new Request("http://localhost/__oxide/action", {
        headers: { host: "localhost", origin: "http://localhost" },
      }),
      send: (data: string) => {
        sent.push(data);
      },
    };

    const pending = hooks.message(peer, {
      text: () =>
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "ticks.ticks",
          params: { args: [] },
        }),
    });

    await waitUntil(() => sent.length > 0, 5000);
    const first = sent.at(0);
    if (first === undefined) {
      throw new Error("timed out waiting for first WebSocket NDJSON frame");
    }
    expect(sent.length).toBe(1);
    expect(JSON.parse(first.trim())).toEqual({
      chunk: true,
      id: 1,
      jsonrpc: "2.0",
      result: [0],
    });

    fs.writeFileSync(gateFile, "go");
    await pending;
    expect(sent.length).toBeGreaterThanOrEqual(2);
    const second = sent.at(1);
    if (second === undefined) {
      throw new Error("missing second WebSocket NDJSON frame");
    }
    expect(JSON.parse(second.trim())).toEqual({
      chunk: true,
      id: 1,
      jsonrpc: "2.0",
      result: [1],
    });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
