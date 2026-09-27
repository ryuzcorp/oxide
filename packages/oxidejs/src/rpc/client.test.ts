import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import type { NestedClient, RpcClientOptions } from "./client";
import { createClient } from "./client";
import { createActionHandler } from "./server";
import { writeGeneratedActions } from "./test-harness";

const ACTION_PATH = "/__oxide/action";

interface Harness {
  /** Answer the next `count` POSTs with this status instead of running them. */
  failNext: (count: number, status: number) => void;
  posts: () => number;
  url: string;
}

let root = "";
let group: never;
let handlers: never;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-client-"));
  const ctx = JSON.stringify(path.join(import.meta.dir, "../context.ts"));
  fs.writeFileSync(
    path.join(root, "demo.server.ts"),
    `import { action } from ${ctx};
export const ping = action(async () => "pong");
export const stall = action(async () => new Promise(() => {}));
`
  );
  // SAFETY: the generated actions module exports the RpcGroup and its handler layer.
  const mod = (await import(writeGeneratedActions(root))) as {
    actionsHandlers: never;
    default: never;
  };
  group = mod.default;
  handlers = mod.actionsHandlers;
});

afterAll(() => {
  fs.rmSync(root, { force: true, recursive: true });
});

const withServer = async function withServer(
  run: (harness: Harness) => Promise<void>
) {
  const handler = createActionHandler(group, handlers, {
    path: ACTION_PATH,
    sameOrigin: false,
  });
  let posts = 0;
  let failures = 0;
  let failStatus = 503;
  const server = Bun.serve({
    fetch: (request) => {
      posts += 1;
      if (failures > 0) {
        failures -= 1;
        return new Response("upstream unavailable", { status: failStatus });
      }
      return handler(request);
    },
    port: 0,
  });
  try {
    await run({
      failNext: (count, status) => {
        failures = count;
        failStatus = status;
      },
      posts: () => posts,
      url: `http://127.0.0.1:${server.port}${ACTION_PATH}`,
    });
  } finally {
    await server.stop(true);
  }
};

type Call = (...args: { idempotencyKey: string }[]) => Promise<string>;

const demo = function demo(client: NestedClient, name: string): Call {
  const fn = client["demo"]?.[name];
  if (!fn) {
    throw new Error(`expected demo.${name} on the client`);
  }
  // SAFETY: unary demo actions resolve to a Promise.
  return fn as Call;
};

const clientFor = (options: RpcClientOptions) => createClient(group, options);

test("a unary call past `timeout` rejects instead of waiting forever", async () => {
  await withServer(async ({ url }) => {
    const client = clientFor({ timeout: 100, url });
    const started = Date.now();
    await expect(demo(client, "stall")()).rejects.toThrow(
      "demo.stall timed out after 100ms"
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

test("an idempotent call is resent after a 503", async () => {
  await withServer(async ({ failNext, posts, url }) => {
    const client = clientFor({ retries: 2, url });
    failNext(1, 503);
    const result = await demo(client, "ping")({ idempotencyKey: "k-1" });
    expect(result).toBe("pong");
    expect(posts()).toBe(2);
  });
});

test("a call without an idempotency key is not resent", async () => {
  await withServer(async ({ failNext, posts, url }) => {
    const client = clientFor({ retries: 2, url: `${url}?no-key` });
    failNext(1, 503);
    await expect(demo(client, "ping")()).rejects.toThrow();
    expect(posts()).toBe(1);
  });
});

test("retries stop after `retries` attempts", async () => {
  await withServer(async ({ failNext, posts, url }) => {
    const client = clientFor({ retries: 1, url: `${url}?cap` });
    failNext(5, 502);
    await expect(
      demo(client, "ping")({ idempotencyKey: "k-2" })
    ).rejects.toThrow();
    expect(posts()).toBe(2);
  });
});
