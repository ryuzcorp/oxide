import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import * as Schema from "effect/Schema";

import { action } from "./action";
import { generateActionsModule, scanServerFiles } from "./actions";
import { createActionHandler } from "./rpc/server";
import { writeGeneratedActions } from "./rpc/test-harness";
import { SchemaDecodeError, withSchema } from "./with-schema";

const AddTask = Schema.Struct({
  text: Schema.String,
});

describe("withSchema", () => {
  test("decodes a valid payload and runs the handler", async () => {
    const add = action(
      withSchema(AddTask, (payload) => ({
        id: "1",
        text: payload.text,
      }))
    );
    const result = await add({ text: "Milk" });
    expect(result).toEqual({ id: "1", text: "Milk" });
  });

  test("rejects with SchemaDecodeError for invalid input", async () => {
    const add = action(withSchema(AddTask, (payload) => payload.text));
    // SAFETY: intentional bad Encoded shape to assert decode failure.
    await expect(add({ text: 1 } as never)).rejects.toBeInstanceOf(
      SchemaDecodeError
    );
  });

  test("decodes Encoded input into Type for the handler", async () => {
    const run = withSchema(Schema.FiniteFromString, (n) => n + 1);
    expect(await run("41")).toBe(42);
    await expect(run("nope")).rejects.toBeInstanceOf(SchemaDecodeError);
  });

  test("over RPC scrub maps SchemaDecodeError to Invalid params", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-schema-"));
    fs.writeFileSync(
      path.join(root, "add.server.ts"),
      `import * as Schema from "effect/Schema";
import { action } from ${JSON.stringify(path.join(import.meta.dir, "action.ts"))};
import { withSchema } from ${JSON.stringify(path.join(import.meta.dir, "with-schema.ts"))};
const AddTask = Schema.Struct({ text: Schema.String });
export const add = action(withSchema(AddTask, async (p) => p));
`
    );
    try {
      const out = writeGeneratedActions(root, {
        code: generateActionsModule(scanServerFiles(root)),
      });
      const mod = await import(out);
      const fetch = createActionHandler(mod.default, mod.actionsHandlers, {
        path: "/__oxide/action",
        sameOrigin: false,
      });
      const res = await fetch(
        new Request("http://localhost/__oxide/action", {
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "add.add",
            params: { args: [{ text: 1 }] },
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      );
      expect(JSON.parse(await res.text())).toEqual({
        error: {
          code: -32_602,
          message: 'Expected string\n  at ["args"][0]["text"]',
        },
        id: 1,
        jsonrpc: "2.0",
      });
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
