import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import type { ActionContext } from "../context";
import { waitUntil, writeGeneratedActions } from "./test-harness";
import { createWsHooks, wsActionRequestUrl } from "./ws";

test("wsActionRequestUrl preserves https from the upgrade request", () => {
  expect(
    wsActionRequestUrl(
      new Request("https://kit.example.workers.dev/__oxide/action", {
        headers: { Upgrade: "websocket" },
      }),
      "/__oxide/action"
    )
  ).toBe("https://kit.example.workers.dev/__oxide/action");
  expect(
    wsActionRequestUrl(
      new Request("wss://kit.example.workers.dev/__oxide/action"),
      "/__oxide/action"
    )
  ).toBe("https://kit.example.workers.dev/__oxide/action");
  expect(
    wsActionRequestUrl(
      new Request("http://localhost:8787/__oxide/action"),
      "/__oxide/action"
    )
  ).toBe("http://localhost:8787/__oxide/action");
});

const mockSocket = function mockSocket() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    accept() {},
    addEventListener(type: string, fn: () => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    listeners,
    readyState: 1,
    send(_data: string) {},
  };
};

const withWebSocketPair = async function withWebSocketPair(
  client: ReturnType<typeof mockSocket>,
  server: ReturnType<typeof mockSocket>,
  run: () => Promise<void>
) {
  class MockWebSocketPair {
    0 = client;
    1 = server;
  }
  // SAFETY: test installs a stand-in WebSocketPair on globalThis for Workers upgrade path.
  const workerGlobal = globalThis as typeof globalThis & {
    WebSocketPair?: typeof MockWebSocketPair;
  };
  const previous = workerGlobal.WebSocketPair;
  workerGlobal.WebSocketPair = MockWebSocketPair;
  try {
    await run();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(globalThis, "WebSocketPair");
    } else {
      workerGlobal.WebSocketPair = previous;
    }
  }
};

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
      `${JSON.stringify({ jsonrpc: "2.0", method: "@effect/rpc/Pong" })}\n`,
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

test("handleUpgrade returns 101 with WebSocketPair", async () => {
  const server = mockSocket();
  const client = mockSocket();
  const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-ws-pair-"));
  const ctx = JSON.stringify(path.join(import.meta.dir, "../context.ts"));
  fs.writeFileSync(
    path.join(root, "noop.server.ts"),
    `import { action } from ${ctx};
export const ping = action(() => "pong")
`
  );
  const out = writeGeneratedActions(root);

  try {
    await withWebSocketPair(client, server, async () => {
      const mod = await import(out);
      const hooks = createWsHooks(mod.default, mod.actionsHandlers, {
        path: "/__oxide/action",
        sameOrigin: false,
      });
      const response = hooks.handleUpgrade(
        new Request("http://localhost/__oxide/action", {
          headers: {
            Origin: "http://localhost",
            Upgrade: "websocket",
          },
        }),
        { env: { DB: "kit" } }
      );
      expect(response?.status).toBe(101);
      expect(server.listeners.has("message")).toBe(true);
      expect(hooks.handleUpgrade(new Request("http://localhost/other"))).toBe(
        undefined
      );
    });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("handleUpgrade allows localhost Host with 127.0.0.1 URL (celld)", async () => {
  const server = mockSocket();
  const client = mockSocket();
  const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-ws-loopback-"));
  const ctx = JSON.stringify(path.join(import.meta.dir, "../context.ts"));
  fs.writeFileSync(
    path.join(root, "noop.server.ts"),
    `import { action } from ${ctx};
export const ping = action(() => "pong")
`
  );
  const out = writeGeneratedActions(root);

  try {
    await withWebSocketPair(client, server, async () => {
      const mod = await import(out);
      const hooks = createWsHooks(mod.default, mod.actionsHandlers, {
        path: "/__oxide/action",
        sameOrigin: true,
      });
      const response = hooks.handleUpgrade(
        new Request("http://127.0.0.1:8080/__oxide/action", {
          headers: {
            Host: "localhost:8080",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          },
        })
      );
      expect(response?.status).toBe(101);
    });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("handleUpgrade allows missing Origin when sameOrigin (celld)", async () => {
  const server = mockSocket();
  const client = mockSocket();
  const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-ws-celld-"));
  const ctx = JSON.stringify(path.join(import.meta.dir, "../context.ts"));
  fs.writeFileSync(
    path.join(root, "noop.server.ts"),
    `import { action } from ${ctx};
export const ping = action(() => "pong")
`
  );
  const out = writeGeneratedActions(root);

  try {
    await withWebSocketPair(client, server, async () => {
      const mod = await import(out);
      const hooks = createWsHooks(mod.default, mod.actionsHandlers, {
        path: "/__oxide/action",
        sameOrigin: true,
      });
      const response = hooks.handleUpgrade(
        new Request("http://127.0.0.1:8080/__oxide/action", {
          headers: {
            Host: "127.0.0.1:8080",
            Upgrade: "websocket",
          },
        })
      );
      expect(response?.status).toBe(101);

      const cross = hooks.handleUpgrade(
        new Request("http://127.0.0.1:8080/__oxide/action", {
          headers: {
            Host: "127.0.0.1:8080",
            Origin: "https://evil.example",
            Upgrade: "websocket",
          },
        })
      );
      expect(cross?.status).toBe(403);
    });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("handleUpgrade sends when readyState is unset (Workers quirk)", async () => {
  const sent: string[] = [];
  const listeners = new Map<string, Set<(event: { data: string }) => void>>();
  const server = {
    accept() {},
    addEventListener(
      type: string,
      fn: ((event: { data: string }) => void) | (() => void)
    ) {
      const set = listeners.get(type) ?? new Set();
      // SAFETY: test registers message/close/error listeners with compatible shapes.
      set.add(fn as (event: { data: string }) => void);
      listeners.set(type, set);
    },
    // Some Worker runtimes leave readyState unset after accept().
    // SAFETY: optional readyState models the Workers quirk under test.
    readyState: undefined as number | undefined,
    send(data: string) {
      sent.push(data);
    },
  };
  const client = mockSocket();
  const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-ws-open-"));
  const ctx = JSON.stringify(path.join(import.meta.dir, "../context.ts"));
  fs.writeFileSync(
    path.join(root, "noop.server.ts"),
    `import { action } from ${ctx};
export const ping = action(() => "pong")
`
  );
  const out = writeGeneratedActions(root);

  try {
    // SAFETY: test fixture stubs Worker WebSocket methods (accept/send/listeners).
    await withWebSocketPair(client, server as never, async () => {
      const mod = await import(out);
      const hooks = createWsHooks(mod.default, mod.actionsHandlers, {
        path: "/__oxide/action",
        sameOrigin: false,
      });
      const response = hooks.handleUpgrade(
        new Request("http://localhost/__oxide/action", {
          headers: { Upgrade: "websocket" },
        })
      );
      expect(response?.status).toBe(101);
      const onMessage = listeners.get("message");
      expect(onMessage?.size).toBe(1);
      for (const fn of onMessage ?? []) {
        fn({
          data: JSON.stringify({ jsonrpc: "2.0", method: "@effect/rpc/Ping" }),
        });
      }
      await waitUntil(() => sent.length > 0, 2000);
      expect(sent).toEqual([
        `${JSON.stringify({ jsonrpc: "2.0", method: "@effect/rpc/Pong" })}\n`,
      ]);
    });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("handleUpgrade does not send on a closed socket", async () => {
  const sent: string[] = [];
  const listeners = new Map<string, Set<(event: { data: string }) => void>>();
  const server = {
    accept() {},
    addEventListener(
      type: string,
      fn: ((event: { data: string }) => void) | (() => void)
    ) {
      const set = listeners.get(type) ?? new Set();
      // SAFETY: test registers message/close/error listeners with compatible shapes.
      set.add(fn as (event: { data: string }) => void);
      listeners.set(type, set);
    },
    readyState: 3,
    send(data: string) {
      sent.push(data);
    },
  };
  const client = mockSocket();
  const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-ws-closed-"));
  const ctx = JSON.stringify(path.join(import.meta.dir, "../context.ts"));
  fs.writeFileSync(
    path.join(root, "noop.server.ts"),
    `import { action } from ${ctx};
export const ping = action(() => "pong")
`
  );
  const out = writeGeneratedActions(root);

  try {
    // SAFETY: test fixture stubs Worker WebSocket methods (accept/send/listeners).
    await withWebSocketPair(client, server as never, async () => {
      const mod = await import(out);
      const hooks = createWsHooks(mod.default, mod.actionsHandlers, {
        path: "/__oxide/action",
        sameOrigin: false,
      });
      hooks.handleUpgrade(
        new Request("http://localhost/__oxide/action", {
          headers: { Upgrade: "websocket" },
        })
      );
      for (const fn of listeners.get("message") ?? []) {
        fn({
          data: JSON.stringify({ jsonrpc: "2.0", method: "@effect/rpc/Ping" }),
        });
      }
      await Bun.sleep(20);
      expect(sent).toEqual([]);
    });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("handleUpgrade calls custom accept for hibernation hooks", async () => {
  const server = mockSocket();
  const client = mockSocket();
  const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-ws-accept-"));
  const ctx = JSON.stringify(path.join(import.meta.dir, "../context.ts"));
  fs.writeFileSync(
    path.join(root, "noop.server.ts"),
    `import { action } from ${ctx};
export const ping = action(() => "pong")
`
  );
  const out = writeGeneratedActions(root);
  let accepted: typeof server | undefined;

  try {
    await withWebSocketPair(client, server, async () => {
      const mod = await import(out);
      const hooks = createWsHooks(mod.default, mod.actionsHandlers, {
        accept: (ws) => {
          // SAFETY: handleUpgrade passes pair[1]; mock identity check vs DOM WebSocket typing.
          if ((ws as object) !== server) {
            throw new Error("expected server socket from WebSocketPair");
          }
          server.accept();
          accepted = server;
        },
        path: "/__oxide/action",
        sameOrigin: false,
      });
      const response = hooks.handleUpgrade(
        new Request("http://localhost/__oxide/action", {
          headers: { Upgrade: "websocket" },
        })
      );
      expect(response?.status).toBe(101);
      expect(accepted).toBe(server);
    });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
