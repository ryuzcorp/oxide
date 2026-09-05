import { expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import type { ActionContext } from "../context";
import { createClient } from "./client";
import { waitUntil, writeGeneratedActions } from "./test-harness";
import { createWsHooks } from "./ws";

const listenPort = function listenPort(server: http.Server) {
  const { promise, resolve } = Promise.withResolvers<number>();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null) {
      resolve(0);
      return;
    }
    // SAFETY: listen(0, host) binds TCP; address is AddressInfo, not a pipe path string.
    resolve((address as AddressInfo).port);
  });
  return promise;
};

const openWebSocket = function openWebSocket(url: string) {
  const ws = new WebSocket(url);
  const { promise, reject, resolve } = Promise.withResolvers<WebSocket>();
  ws.addEventListener(
    "open",
    () => {
      resolve(ws);
    },
    { once: true }
  );
  ws.addEventListener(
    "error",
    () => {
      reject(new Error("WebSocket failed to open"));
    },
    { once: true }
  );
  return promise;
};

test("createClient over ws transport resolves calls through a real socket", async () => {
  // Regression: loadClient used to build the protocol layer in a transient
  // scope, killing the socket read loop before it dialed — every call hung.
  const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-ws-client-"));
  const ctx = JSON.stringify(path.join(import.meta.dir, "../context.ts"));
  fs.writeFileSync(
    path.join(root, "hello.server.ts"),
    `import { action } from ${ctx};
export const hello = action(async (name: string) => \`hi \${name}\`)
`
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
    // SAFETY: Node upgrade socket is Duplex; crossws adapter accepts it at runtime.
    wss.handleUpgrade(req, socket as never, head);
  });
  const port = await listenPort(server);

  const client = createClient(mod.default, {
    transport: "ws",
    url: `ws://127.0.0.1:${port}/__oxide/action`,
  });
  try {
    const helloMod = client["hello"];
    const helloFn = helloMod?.["hello"];
    if (helloFn === undefined) {
      throw new Error("hello.hello action missing from client");
    }
    const { promise: timeout, reject: rejectTimeout } =
      Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      rejectTimeout(new Error("ws client call timed out"));
    }, 5000);
    try {
      const result = await Promise.race([helloFn("Regression"), timeout]);
      expect(result).toBe("hi Regression");
    } finally {
      clearTimeout(timer);
    }
  } finally {
    server.close();
    fs.rmSync(root, { force: true, recursive: true });
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
    await Bun.sleep(5);
  }
  yield 1;
})
`
  );
  const out = writeGeneratedActions(root);

  const mod = await import(out);
  const server = http.createServer();
  const { default: crossws } = await import("crossws/adapters/node");
  // SAFETY: crossws hook types are structurally looser than ours (see plugin.ts).
  const wss = crossws({
    hooks: createWsHooks(mod.default as never, mod.actionsHandlers as never, {
      createContext: () =>
        // SAFETY: test peer context only needs req + a marker field for this assertion.
        ({
          marker: "from-peer",
          req: new Request("http://localhost/__oxide/action"),
        }) as ActionContext,
      path: "/__oxide/action",
      sameOrigin: false,
    }) as never,
  });
  server.on("upgrade", (req, socket, head) => {
    // SAFETY: Node upgrade socket is Duplex; crossws adapter accepts it at runtime.
    wss.handleUpgrade(req, socket as never, head);
  });
  const port = await listenPort(server);

  const frames: string[] = [];
  const ws = await openWebSocket(`ws://127.0.0.1:${port}/__oxide/action`);
  ws.addEventListener("message", (event) => {
    frames.push(String(event.data));
  });

  try {
    ws.send(
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "ticks.ticks",
        params: { args: [] },
      })
    );

    await waitUntil(() => frames.length > 0, 5000);
    const first = frames.at(0);
    if (first === undefined) {
      throw new Error("timed out waiting for first WebSocket NDJSON frame");
    }
    expect(frames.length).toBe(1);
    expect(JSON.parse(first.trim())).toEqual({
      chunk: true,
      id: 1,
      jsonrpc: "2.0",
      result: [0],
    });

    fs.writeFileSync(gateFile, "go");
    await waitUntil(() => frames.length >= 2, 5000);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    const second = frames.at(1);
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
    ws.close();
    server.close();
    fs.rmSync(root, { force: true, recursive: true });
  }
});
