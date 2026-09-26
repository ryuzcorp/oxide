import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import type { OxidejsJson } from "../types";
import { batch } from "./batch";
import type { NestedClient } from "./client";
import { createClient } from "./client";
import { createActionHandler } from "./server";
import { writeGeneratedActions } from "./test-harness";

interface Recorded {
  body: string;
  url: string;
}

interface JsonRpcRequest {
  headers?: [string, string][] | undefined;
  id: string;
  method: string;
  params: { args: OxidejsJson[] };
}

/** Proxy calls resolve to a Promise for unary actions, a generator for streams. */
type CallResult<A> = Promise<A> | AsyncGenerator<A>;

const isAsyncGenerator = function isAsyncGenerator<A>(
  value: CallResult<A>
): value is AsyncGenerator<A> {
  // SAFETY: narrowed probe of the optional iterator `next` method.
  return typeof (value as { next?: unknown }).next === "function";
};

const unary = function unary<A>(value: CallResult<A>): Promise<A> {
  if (isAsyncGenerator(value)) {
    throw new TypeError("expected a unary action");
  }
  return value;
};

const streamed = function streamed<A>(value: CallResult<A>): AsyncGenerator<A> {
  if (isAsyncGenerator(value)) {
    return value;
  }
  throw new TypeError("expected a stream action");
};

const required = function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`expected a client method for ${name}`);
  }
  return value;
};

/**
 * Name the generated `demo.server.ts` surface. The client proxy is schema-blind,
 * so each call is narrowed to the shape its action actually returns.
 */
const demoActions = function demoActions(client: NestedClient) {
  const demo = required(client["demo"], "demo");
  const add = required(demo["add"], "add");
  return {
    add: (a: number, b: number, options?: { signal: AbortSignal }) =>
      // Trailing undefined would land in the payload as a third argument.
      unary(options === undefined ? add(a, b) : add(a, b, options)),
    boom: () => unary(required(demo["boom"], "boom")()),
    key: (options: { idempotencyKey: string }) =>
      unary(required(demo["key"], "key")(options)),
    label: (name: string) => unary(required(demo["label"], "label")(name)),
    ping: () => unary(required(demo["ping"], "ping")()),
    ticks: (count: number) => streamed(required(demo["ticks"], "ticks")(count)),
  };
};

const ACTION_PATH = "/__oxide/action";

/**
 * Client + generated action handler over a real HTTP server, recording every
 * request body the client posts (one POST per batch, per the transport).
 */
const withBatchHarness = async function withBatchHarness(
  run: (client: NestedClient, posts: Recorded[]) => Promise<void>
) {
  const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-batch-"));
  const ctx = JSON.stringify(path.join(import.meta.dir, "../context.ts"));
  fs.writeFileSync(
    path.join(root, "demo.server.ts"),
    `import { action, useIdempotencyKey } from ${ctx};
export const ping = action(async () => "pong");
export const add = action(async (a: number, b: number) => a + b);
export const label = action(async (name: string) => ({ name }));
export const boom = action(async () => {
  throw new Error("kaboom");
});
export const key = action(async () => useIdempotencyKey() ?? null);
export const ticks = action(async function* (count: number) {
  for (let i = 0; i < count; i++) {
    yield i;
  }
});
`
  );
  const out = writeGeneratedActions(root);
  const mod = await import(out);
  const handler = createActionHandler(mod.default, mod.actionsHandlers, {
    path: ACTION_PATH,
    sameOrigin: false,
  });
  const posts: Recorded[] = [];
  const server = Bun.serve({
    fetch: async (request) => {
      posts.push({ body: await request.clone().text(), url: request.url });
      return handler(request);
    },
    port: 0,
  });
  const client = createClient(mod.default, {
    url: `http://127.0.0.1:${server.port}${ACTION_PATH}`,
  });
  try {
    await run(client, posts);
  } finally {
    await server.stop(true);
    fs.rmSync(root, { force: true, recursive: true });
  }
};

const parseBody = function parseBody(post: Recorded | undefined): OxidejsJson {
  if (!post) {
    throw new Error("expected the client to post a request");
  }
  // SAFETY: recorded bodies are JSON text written by the client transport.
  return JSON.parse(post.body) as OxidejsJson;
};

const isJsonObject = function isJsonObject(
  value: OxidejsJson | undefined
): value is { [key: string]: OxidejsJson } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
};

const toRequest = function toRequest(frame: OxidejsJson): JsonRpcRequest {
  if (!isJsonObject(frame)) {
    throw new Error("expected JSON-RPC request objects");
  }
  const { headers, params } = frame;
  const args = isJsonObject(params) ? params["args"] : undefined;
  return {
    // SAFETY: batch frames carry header tuples, an id, a method, and `{ args }`.
    headers: Array.isArray(headers)
      ? (headers as [string, string][])
      : undefined,
    id: String(frame["id"]),
    method: String(frame["method"]),
    params: { args: Array.isArray(args) ? args : [] },
  };
};

/** Frames of a body: one object for a single call, an array for a batch. */
const asRequests = function asRequests(body: OxidejsJson): JsonRpcRequest[] {
  return Array.isArray(body) ? body.map(toRequest) : [toRequest(body)];
};

const methodsOf = function methodsOf(body: OxidejsJson): string[] {
  return asRequests(body).map((request) => request.method);
};

test("batch() posts one JSON-RPC 2.0 batch for pending calls", async () => {
  await withBatchHarness(async (client, posts) => {
    const demo = demoActions(client);
    const [sum, label] = await batch(demo.add(1, 2), demo.label("ryuz"));
    expect(sum).toBe(3);
    expect(label).toEqual({ name: "ryuz" });
    expect(posts).toHaveLength(1);

    const requests = asRequests(parseBody(posts[0]));
    expect(requests.map((request) => request.method)).toEqual([
      "demo.add",
      "demo.label",
    ]);
    expect(requests.map((request) => request.params)).toEqual([
      { args: [1, 2] },
      { args: ["ryuz"] },
    ]);
  });
});

test("batch() accepts an array of calls and zero-arg handles", async () => {
  await withBatchHarness(async (client, posts) => {
    const demo = demoActions(client);
    const [sum, pong] = await batch([demo.add(3, 4), demo.ping]);
    expect(sum).toBe(7);
    expect(pong).toBe("pong");
    expect(posts).toHaveLength(1);
    expect(methodsOf(parseBody(posts[0]))).toEqual(["demo.add", "demo.ping"]);
  });
});

test("batch() accepts thunks so calls can take arguments", async () => {
  await withBatchHarness(async (client, posts) => {
    const demo = demoActions(client);
    const [sum, label] = await batch(
      () => demo.add(5, 6),
      () => demo.label("thunk")
    );
    expect(sum).toBe(11);
    expect(label).toEqual({ name: "thunk" });
    expect(posts).toHaveLength(1);
    expect(methodsOf(parseBody(posts[0]))).toEqual(["demo.add", "demo.label"]);
  });
});

test("batch() rejects with the failing call and still resolves siblings", async () => {
  await withBatchHarness(async (client, posts) => {
    const demo = demoActions(client);
    const sibling = demo.add(1, 1);
    await expect(batch(sibling, demo.boom())).rejects.toThrow("Internal error");
    expect(await sibling).toBe(2);
    expect(posts).toHaveLength(1);
  });
});

test("batch() carries per-call idempotency keys", async () => {
  await withBatchHarness(async (client, posts) => {
    const demo = demoActions(client);
    const [first, second] = await batch(
      demo.key({ idempotencyKey: "one" }),
      demo.label("plain")
    );
    expect(first).toBe("one");
    expect(second).toEqual({ name: "plain" });
    expect(posts).toHaveLength(1);
    expect(asRequests(parseBody(posts[0]))[0]?.headers).toEqual([
      ["x-oxide-idempotency-key", "one"],
    ]);
  });
});

test("a call outside batch() still posts a single request body", async () => {
  await withBatchHarness(async (client, posts) => {
    const demo = demoActions(client);
    expect(await demo.add(2, 3)).toBe(5);
    expect(posts).toHaveLength(1);
    const body = parseBody(posts[0]);
    expect(Array.isArray(body)).toBe(false);
    expect(methodsOf(body)).toEqual(["demo.add"]);
  });
});

test("stream actions are never folded into a batch", async () => {
  await withBatchHarness(async (client, posts) => {
    const demo = demoActions(client);
    const seen: number[] = [];
    for await (const value of await demo.ticks(3)) {
      seen.push(Number(value));
    }
    expect(seen).toEqual([0, 1, 2]);
    expect(posts).toHaveLength(1);
    expect(Array.isArray(parseBody(posts[0]))).toBe(false);

    await expect(batch(() => demo.ticks(2))).rejects.toBeInstanceOf(TypeError);
  });
});

test("an aborted call never joins the batch", async () => {
  await withBatchHarness(async (client, posts) => {
    const demo = demoActions(client);
    const controller = new AbortController();
    const aborted = demo.add(1, 2, { signal: controller.signal });
    const kept = demo.label("kept");
    controller.abort();

    const outcome = await batch(aborted, kept).then(
      () => "resolved",
      () => "rejected"
    );
    expect(outcome).toBe("rejected");
    expect(await kept).toEqual({ name: "kept" });
    expect(posts).toHaveLength(1);
    expect(methodsOf(parseBody(posts[0]))).toEqual(["demo.label"]);
  });
});

test("batch() with no calls returns [] and never posts", async () => {
  await withBatchHarness(async (_client, posts) => {
    expect(await batch([])).toEqual([]);
    expect(posts).toHaveLength(0);
  });
});
