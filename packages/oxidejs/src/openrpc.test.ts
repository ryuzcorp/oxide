/* eslint-disable max-classes-per-file -- Schema.TaggedError fixtures per test */
import { describe, expect, test } from "bun:test";

import * as Schema from "effect/Schema";

import type { ActionMeta } from "./action";
import {
  buildOpenRpcDocument,
  codecToJsonSchema,
  createOpenRpcResponse,
  matchesOpenRpcPath,
  OPENRPC_PATH,
} from "./openrpc";

describe("openrpc", () => {
  test("matchesOpenRpcPath", () => {
    expect(matchesOpenRpcPath(OPENRPC_PATH)).toBe(true);
    expect(matchesOpenRpcPath(`${OPENRPC_PATH}/`)).toBe(true);
    expect(matchesOpenRpcPath("/__oxide/action")).toBe(false);
  });

  test("buildOpenRpcDocument lists stamped action schemas", () => {
    // eslint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory, not a thrown Error
    class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
      id: Schema.String,
    }) {}
    const payload = Schema.Struct({ orderId: Schema.String });
    const meta: ActionMeta = {
      error: NotFound,
      payload,
      success: Schema.Struct({ ok: Schema.Boolean }),
    };
    const doc = buildOpenRpcDocument([{ meta, name: "invoice.charge" }], {
      actionUrl: "http://localhost/__oxide/action",
    });
    expect(doc.openrpc).toBe("1.3.2");
    expect(doc.servers[0]?.url).toBe("http://localhost/__oxide/action");
    expect(doc.methods).toHaveLength(1);
    expect(doc.methods[0]?.name).toBe("invoice.charge");
    expect(doc.methods[0]?.paramStructure).toBe("by-name");
    expect(doc.methods[0]?.params[0]?.name).toBe("args");
    expect(doc.methods[0]?.errors?.[0]?.code).toBe(-32_000);
    expect(doc.components.schemas["NotFoundEncoded"]).toBeDefined();
  });

  test("codecToJsonSchema falls back for missing codecs", () => {
    expect(codecToJsonSchema()).toEqual({
      definitions: {},
      schema: {},
    });
  });

  test("createOpenRpcResponse serves GET JSON", async () => {
    const response = createOpenRpcResponse(
      [{ meta: { success: Schema.String }, name: "test.ping" }],
      new Request("http://localhost/__oxide/openrpc"),
      { actionPath: "/__oxide/action" }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    // SAFETY: OpenRPC document is JSON.
    const body = (await response.json()) as {
      methods: { name: string }[];
      openrpc: string;
    };
    expect(body.openrpc).toBe("1.3.2");
    expect(body.methods[0]?.name).toBe("test.ping");
  });

  test("createOpenRpcResponse rejects non-GET", () => {
    const response = createOpenRpcResponse(
      [],
      new Request("http://localhost/__oxide/openrpc", { method: "POST" }),
      { actionPath: "/__oxide/action" }
    );
    expect(response.status).toBe(405);
  });

  test("buildOpenRpcDocument throws on conflicting component schemas", () => {
    // Same TaggedError tag → same Encoded def name; different fields → conflict.
    // eslint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory
    class ConflictA extends Schema.TaggedError<ConflictA>()("Conflict", {
      a: Schema.String,
    }) {}
    // eslint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory
    class ConflictB extends Schema.TaggedError<ConflictB>()("Conflict", {
      b: Schema.Number,
    }) {}
    expect(() =>
      buildOpenRpcDocument(
        [
          {
            meta: { error: ConflictA, success: Schema.String },
            name: "a.run",
          },
          {
            meta: { error: ConflictB, success: Schema.String },
            name: "b.run",
          },
        ],
        { actionUrl: "http://localhost/__oxide/action" }
      )
    ).toThrow(/components\.schemas\[/u);
  });
});
