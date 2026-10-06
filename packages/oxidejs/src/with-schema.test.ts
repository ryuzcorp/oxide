import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import * as Schema from "effect/Schema";

import { action } from "./action";
import { SchemaDecodeError } from "./action-error";
import { generateActionsModule, scanServerFiles } from "./actions";
import { createActionHandler } from "./rpc/server";
import { writeGeneratedActions } from "./rpc/test-harness";
import { withSchema } from "./with-schema";

const AddTask = Schema.Struct({
  text: Schema.String,
});

/** Compile-time equality: `false` fails the `= true` assignment. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const asyncHandle = action(
  withSchema(AddTask, async (payload) => {
    await Promise.resolve();
    return payload.text;
  })
);
const syncHandle = action(withSchema(AddTask, (payload) => payload.text));
const directRun = withSchema(Schema.FiniteFromString, (n) => n + 1);

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

  test("fails with SchemaDecodeError for invalid input", async () => {
    const add = action(withSchema(AddTask, (payload) => payload.text));
    // SAFETY: intentional bad Encoded shape to assert decode failure.
    await expect(add({ text: 1 } as never)).rejects.toBeInstanceOf(
      SchemaDecodeError
    );
  });

  test("decodes Encoded input into Type for the handler", async () => {
    const run = withSchema(Schema.FiniteFromString, (n) => n + 1);
    expect(await run("41")).toBe(42);
    expect(() => run("nope")).toThrow(SchemaDecodeError);
  });

  test("rejects declaring the payload with both withSchema and { payload }", () => {
    expect(() =>
      action(
        withSchema(AddTask, (payload) => payload.text),
        {
          payload: AddTask,
        }
      )
    ).toThrow("declares the payload twice");
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

  test("a transforming schema over RPC decodes exactly once", async () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, "oxide-fin-"));
    fs.writeFileSync(
      path.join(root, "fin.server.ts"),
      `import * as Schema from "effect/Schema";
import { action } from ${JSON.stringify(path.join(import.meta.dir, "action.ts"))};
import { withSchema } from ${JSON.stringify(path.join(import.meta.dir, "with-schema.ts"))};
export const fin = action(withSchema(Schema.FiniteFromString, (n) => n + 1));
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
      const call = async (args: unknown[]) => {
        const res = await fetch(
          new Request("http://localhost/__oxide/action", {
            body: JSON.stringify({
              id: 1,
              jsonrpc: "2.0",
              method: "fin.fin",
              params: { args },
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          })
        );
        return JSON.parse(await res.text());
      };
      expect(await call(["41"])).toEqual({
        id: 1,
        jsonrpc: "2.0",
        result: 42,
      });
      expect(await call([41])).toEqual({
        error: { code: -32_602, message: 'Expected string\n  at ["args"][0]' },
        id: 1,
        jsonrpc: "2.0",
      });
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("withSchema types", () => {
  test("the awaited action result is the handler data, not a union", () => {
    // A data-or-Effect union return would not be assignable to these promises.
    const asyncResult: Promise<string> = asyncHandle({ text: "x" });
    const syncResult: Promise<string> = syncHandle({ text: "x" });
    const directResult: number = directRun("41");
    const directIsNumber: Equal<typeof directResult, number> = true;
    void asyncResult;
    void syncResult;
    expect(directIsNumber).toBe(true);
  });
});
