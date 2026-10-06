import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { wrapClientRpc } from "./action";
import {
  ActionError,
  ActionFailure,
  SchemaDecodeError,
  toActionError,
} from "./action-error";
import type { NestedClient } from "./rpc/client";
import { createClient } from "./rpc/client";
import { createActionHandler } from "./rpc/server";
import {
  writeGeneratedActions,
  writeGeneratedClient,
} from "./rpc/test-harness";

const ACTION_PATH = "/__oxide/action";

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
  // SAFETY: tests call unary demo actions; the proxy returns a Promise for them.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-unknown-returns -- schema-blind client proxy cast in a test harness
  const unary = fn as unknown as (...args: unknown[]) => Promise<unknown>;
  return wrapClientRpc(unary);
};

const withHarness = async function withHarness(
  run: (client: NestedClient) => Promise<void>
) {
  const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-errors-"));
  const ctx = JSON.stringify(path.join(import.meta.dir, "context.ts"));
  fs.writeFileSync(
    path.join(root, "demo.server.ts"),
    `import { action, fail, withSchema } from ${ctx};
import * as Schema from "effect/Schema";
// oxlint-disable-next-line unicorn/throw-new-error
class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { id: Schema.String }) {}
export const failAction = action(async () => { fail("User facing failure"); });
export const declared = action(async () => { throw new NotFound({ id: "1" }); }, { error: NotFound });
export const declaredFail = action(async () => { fail("Declared schema failure"); }, { error: NotFound });
export const boom = action(async () => { throw new Error("secret-leak-check"); });
export const add = action(withSchema(Schema.Struct({ text: Schema.String }), async (p) => p.text));
`
  );
  const mod = await import(writeGeneratedActions(root));
  // SAFETY: the browser stub exports the schema-blind client RpcGroup.
  const clientMod = (await import(writeGeneratedClient(root))) as {
    default: Parameters<typeof createClient>[0];
  };
  const handler = createActionHandler(mod.default, mod.actionsHandlers, {
    path: ACTION_PATH,
    sameOrigin: false,
  });
  const server = Bun.serve({ fetch: (request) => handler(request), port: 0 });
  const client = createClient(clientMod.default, {
    url: `http://127.0.0.1:${server.port}${ACTION_PATH}`,
  });
  try {
    await run(client);
  } finally {
    await server.stop(true);
    fs.rmSync(root, { force: true, recursive: true });
  }
};

const rejection = async function rejection(
  call: Promise<unknown>
): Promise<Error & { code?: number; _tag?: string; id?: string }> {
  try {
    await call;
  } catch (error) {
    // SAFETY: toActionError guarantees an Error with the fields under test.
    return error as Error & { code?: number; _tag?: string; id?: string };
  }
  throw new Error("expected the action call to reject");
};

test("a user-facing failure rejects with a real Error and its tag", async () => {
  await withHarness(async (client) => {
    const handle = callClient(client, "demo", "failAction");
    const error = await rejection(handle());
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ActionFailure);
    expect(error._tag).toBe("ActionFailure");
    expect(error.message).toBe("User facing failure");
    expect(error.code).toBe(-32_000);
    expect(String(error)).toContain("User facing failure");
    expect(String(error)).not.toContain("[object Object]");
  });
});

test("a declared tagged error keeps its tag and decoded fields", async () => {
  await withHarness(async (client) => {
    const handle = callClient(client, "demo", "declared");
    const error = await rejection(handle());
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ActionError);
    expect(error._tag).toBe("NotFound");
    expect(error.id).toBe("1");
    expect(error.code).toBe(-32_000);
  });
});

test("fail() also surfaces when the action declares another error schema", async () => {
  await withHarness(async (client) => {
    const error = await rejection(callClient(client, "demo", "declaredFail")());
    expect(error).toBeInstanceOf(ActionFailure);
    expect(error._tag).toBe("ActionFailure");
    expect(error.message).toBe("Declared schema failure");
  });
});

test("a plain throw stays masked as Internal error", async () => {
  await withHarness(async (client) => {
    const handle = callClient(client, "demo", "boom");
    const error = await rejection(handle());
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ActionError);
    expect(error._tag).toBe("ActionError");
    expect(error.code).toBe(-32_603);
    expect(error.message).toBe("Internal error");
    expect(JSON.stringify(error.message)).not.toContain("secret-leak-check");
  });
});

test("an RPC payload decode failure rejects with SchemaDecodeError", async () => {
  await withHarness(async (client) => {
    const handle = callClient(client, "demo", "add");
    // SAFETY: deliberately invalid Encoded payload to hit the RPC decode.
    const error = await rejection(handle({ text: 1 } as never));
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SchemaDecodeError);
    expect(error._tag).toBe("SchemaDecodeError");
    expect(error.code).toBe(-32_602);
    expect(error.message).toContain("Expected string");
  });
});

test("handle.set() rejects with the same normalized error", async () => {
  await withHarness(async (client) => {
    const handle = callClient(client, "demo", "failAction");
    const error = await rejection(handle.set());
    expect(error).toBeInstanceOf(ActionFailure);
    expect(error.message).toBe("User facing failure");
  });
});

test("a __proto__ key in wire error data cannot swap the error prototype", () => {
  const error = toActionError({
    code: -32_000,
    data: JSON.parse('{"_tag":"NotFound","__proto__":{"polluted":true}}'),
    message: "NotFound",
  });
  expect(Object.getPrototypeOf(error)).toBe(ActionError.prototype);
  expect(error).toBeInstanceOf(ActionError);
  expect("polluted" in error).toBe(false);
  expect(error).toMatchObject({ _tag: "NotFound" });
});
