import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { generateActionsModule, scanServerFiles } from "../actions";
import { createWsHooks } from "./ws";

const RPC_MODULE = path.join(import.meta.dir, "index.ts");

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
  const out = path.join(root, "actions.mjs");
  fs.writeFileSync(
    out,
    generateActionsModule(scanServerFiles(root)).replaceAll("oxidejs/rpc", RPC_MODULE),
  );

  try {
    const mod = await import(out);
    const hooks = createWsHooks(mod.default, mod.actionsHandlers, { path: "/__oxide/action" });
    const sent: string[] = [];
    const peer = {
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

    // Wait until the first frame is forwarded without opening the gate.
    const started = Date.now();
    while (sent.length === 0 && Date.now() - started < 1000) {
      await new Promise((r) => setTimeout(r, 5));
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
