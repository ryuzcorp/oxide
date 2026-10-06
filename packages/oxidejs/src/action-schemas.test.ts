import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { wrapClientRpc, wrapClientStreamRpc } from "./action";
import { ActionError, ActionFailure, SchemaDecodeError } from "./action-error";
import type { NestedClient } from "./rpc/client";
import { createClient } from "./rpc/client";
import { createActionHandler } from "./rpc/server";
import {
  writeGeneratedActions,
  writeGeneratedClient,
} from "./rpc/test-harness";

const ACTION_PATH = "/__oxide/action";

interface Harness {
  /** Requests that reached the server, to prove client-side rejections never send. */
  requests: number;
}

/** The generated stub wraps `client[mod][name]` in `wrapClientRpc`; mirror it. */
const callClient = function callClient(
  client: NestedClient,
  mod: string,
  name: string
) {
  const fn = client[mod]?.[name];
  if (!fn) {
    throw new Error(`expected ${mod}.${name} on the client`);
  }
  // SAFETY: tests call unary demo actions; the schema-aware proxy returns a Promise for them.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-unknown-returns -- schema-aware client proxy cast in a test harness
  const unary = fn as unknown as (...args: unknown[]) => Promise<unknown>;
  return wrapClientRpc(unary);
};

const callClientStream = function callClientStream(
  client: NestedClient,
  mod: string,
  name: string
) {
  const fn = client[mod]?.[name];
  if (!fn) {
    throw new Error(`expected ${mod}.${name} on the client`);
  }
  // SAFETY: stream tests call the generated async generator; the proxy types it loosely.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-unknown-returns -- stream client proxy cast in a test harness
  const stream = fn as unknown as () => AsyncGenerator<unknown>;
  return wrapClientStreamRpc(stream);
};

/**
 * A server file that imports its schemas from a plain (non-`.server`) module,
 * plus one action per fallback path.
 */
const writeDemoServer = function writeDemoServer(root: string) {
  fs.writeFileSync(
    path.join(root, "shared.ts"),
    `import * as Schema from "effect/Schema";
export const TaskText = Schema.Struct({ text: Schema.String });
export const Stamp = Schema.Date;
// oxlint-disable-next-line unicorn/throw-new-error
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.String }) {}
`
  );
  const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
  fs.writeFileSync(
    path.join(root, "demo.server.ts"),
    `import { action, fail } from ${ctx};
import * as Schema from "effect/Schema";
import { NotFound, Stamp, TaskText } from "./shared";
// oxlint-disable-next-line unicorn/throw-new-error
class LocalError extends Schema.TaggedError<LocalError>()("LocalError", { id: Schema.String }) {}
export const add = action(async (payload) => payload.text, { payload: TaskText });
export const scale = action(async (n) => n * 2, { payload: Schema.FiniteFromString });
export const when = action(async () => new Date("2020-05-06T07:08:09.000Z"), { success: Stamp });
export const declared = action(async () => { throw new NotFound({ id: "42" }); }, { error: NotFound, success: Stamp });
export const local = action(async () => { throw new LocalError({ id: "9" }); }, { error: LocalError });
export const boom = action(async () => { throw new Error("secret-leak-check"); });
export const failer = action(async () => { fail("User facing failure"); });
export const ticks = action(async function* () {
  await Promise.resolve();
  yield new Date("2021-01-02T03:04:05.000Z");
  yield new Date("2022-02-03T04:05:06.000Z");
}, { stream: true, success: Stamp });
`
  );
};

const withHarness = async function withHarness(
  run: (client: NestedClient, harness: Harness, root: string) => Promise<void>
) {
  const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-schemas-"));
  writeDemoServer(root);
  const server = await import(writeGeneratedActions(root));
  // SAFETY: the generated client module exports the schema-aware client RpcGroup.
  const clientMod = (await import(writeGeneratedClient(root))) as {
    default: Parameters<typeof createClient>[0];
  };
  const harness: Harness = { requests: 0 };
  const handler = createActionHandler(server.default, server.actionsHandlers, {
    path: ACTION_PATH,
    sameOrigin: false,
  });
  const http = Bun.serve({
    fetch: (request) => {
      harness.requests += 1;
      return handler(request);
    },
    port: 0,
  });
  const client = createClient(clientMod.default, {
    url: `http://127.0.0.1:${http.port}${ACTION_PATH}`,
  });
  try {
    await run(client, harness, root);
  } finally {
    await http.stop(true);
    fs.rmSync(root, { force: true, recursive: true });
  }
};

const rejection = async function rejection(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    // SAFETY: toActionError guarantees an Error with the fields under test.
    return error as Error & { code?: number; _tag?: string; id?: string };
  }
  throw new Error("expected the action call to reject");
};

test("a declared success schema decodes the wire value on the client", async () => {
  await withHarness(async (client) => {
    const result = await callClient(client, "demo", "when")();
    expect(result).toBeInstanceOf(Date);
    // SAFETY: the assertion above proves the decoded success is a Date.
    expect((result as Date).toISOString()).toBe("2020-05-06T07:08:09.000Z");
  });
});

test("an invalid Encoded payload rejects client-side without a request", async () => {
  await withHarness(async (client, harness) => {
    const add = callClient(client, "demo", "add");
    const error = await rejection(add({ text: 1 }));
    expect(error).toBeInstanceOf(SchemaDecodeError);
    expect(error._tag).toBe("SchemaDecodeError");
    expect(error.code).toBe(-32_602);
    expect(error.message).toContain("Expected string");
    expect(harness.requests).toBe(0);
  });
});

test("a valid Encoded payload still round-trips through the server", async () => {
  await withHarness(async (client, harness) => {
    const add = callClient(client, "demo", "add");
    expect(await add({ text: "Milk" })).toBe("Milk");
    expect(harness.requests).toBe(1);
  });
});

test("a declared tagged error rejects as an instance of the class", async () => {
  await withHarness(async (client, _harness, root) => {
    const shared = await import(path.join(root, "shared.ts"));
    const error = await rejection(callClient(client, "demo", "declared")());
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(shared.NotFound);
    expect(error._tag).toBe("NotFound");
    expect(error.id).toBe("42");
    expect(error.code).toBe(-32_000);
    expect(String(error)).not.toContain("[object Object]");
  });
});

test("a transforming payload schema validates its Encoded side on the client", async () => {
  await withHarness(async (client, harness) => {
    const scale = callClient(client, "demo", "scale");
    // `FiniteFromString`: the client sends the Encoded string, the handler sees a number.
    expect(await scale("21")).toBe(42);
    const error = await rejection(scale(21));
    expect(error).toBeInstanceOf(SchemaDecodeError);
    expect(error.code).toBe(-32_602);
    expect(harness.requests).toBe(1);
  });
});

test("an unresolved error schema keeps the ActionError fallback", async () => {
  await withHarness(async (client) => {
    const error = await rejection(callClient(client, "demo", "local")());
    expect(error).toBeInstanceOf(ActionError);
    expect(error._tag).toBe("LocalError");
    expect(error.id).toBe("9");
    expect(error.code).toBe(-32_000);
  });
});

test("ActionFailure and a masked defect keep their existing errors", async () => {
  await withHarness(async (client) => {
    const failure = await rejection(callClient(client, "demo", "failer")());
    expect(failure).toBeInstanceOf(ActionFailure);
    expect(failure.message).toBe("User facing failure");
    const masked = await rejection(callClient(client, "demo", "boom")());
    expect(masked).toBeInstanceOf(ActionError);
    expect(masked.code).toBe(-32_603);
    expect(masked.message).not.toContain("secret-leak-check");
  });
});

test("stream chunks decode with the declared success schema", async () => {
  await withHarness(async (client) => {
    const chunks: unknown[] = [];
    for await (const chunk of callClientStream(client, "demo", "ticks")()) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBeInstanceOf(Date);
    // SAFETY: the assertion above proves the decoded chunk is a Date.
    expect((chunks[0] as Date).toISOString()).toBe("2021-01-02T03:04:05.000Z");
    expect(chunks[1]).toBeInstanceOf(Date);
  });
});
