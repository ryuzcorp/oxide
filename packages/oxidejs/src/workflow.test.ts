import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as Schema from "effect/Schema";

import {
  generateActionsClientModule,
  generateActionsModule,
  generateWorkerWrapper,
} from "./actions";
import { mergeDurableBindings } from "./core";
import type { DurableWranglerConfig } from "./core";
import { withRequestStore } from "./request-store";
import { toWorkflowBinding, toWorkflowClassName, workflow } from "./workflow";
import {
  assertWorkflowActionCollisions,
  generateWorkflowClassesModule,
  generateWorkflowClientStub,
  parseWorkflowExports,
  scanWorkflowFiles,
} from "./workflow-build";

describe("workflow naming", () => {
  test("binding and className defaults", () => {
    expect(toWorkflowBinding("invoice")).toBe("INVOICE");
    expect(toWorkflowBinding("myInvoice")).toBe("MY_INVOICE");
    expect(toWorkflowClassName("invoice")).toBe("InvoiceWorkflow");
    expect(toWorkflowClassName("InvoiceWorkflow")).toBe("InvoiceWorkflow");
  });
});

describe("parseWorkflowExports", () => {
  test("reads name binding className from workflow()", () => {
    expect(
      parseWorkflowExports(`
        export const invoice = workflow({
          name: "invoice",
          binding: "BILLING",
          className: "BillingWorkflow",
          run: async () => {}
        })
        export const other = action(async () => {})
      `)
    ).toEqual([
      {
        binding: "BILLING",
        className: "BillingWorkflow",
        exportName: "invoice",
        name: "invoice",
      },
    ]);
  });

  test("defaults name from export", () => {
    expect(
      parseWorkflowExports(`
        export const refund = workflow({
          run: async () => {}
        })
      `)
    ).toEqual([
      {
        binding: "REFUND",
        className: "RefundWorkflow",
        exportName: "refund",
        name: "refund",
      },
    ]);
  });

  test("rejects non-literal name / binding", () => {
    expect(() =>
      parseWorkflowExports(`
        export const invoice = workflow({
          name: workflowName,
          run: async () => {}
        })
      `)
    ).toThrow("name: must be a string literal");
    expect(() =>
      parseWorkflowExports(`
        export const invoice = workflow({
          name: "invoice",
          binding: BINDING,
          run: async () => {}
        })
      `)
    ).toThrow("binding: must be a string literal");
  });
});

describe("scanWorkflowFiles", () => {
  test("finds workflow() exports in *.server.ts and rejects collisions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-wf-"));
    fs.writeFileSync(
      path.join(root, "invoice.server.ts"),
      `export const invoice = workflow({ name: "invoice", run: async () => {} })\n`
    );
    try {
      const mods = scanWorkflowFiles(root);
      expect(mods).toHaveLength(1);
      expect(mods[0]?.exports[0]?.className).toBe("InvoiceWorkflow");
      fs.writeFileSync(
        path.join(root, "dup.server.ts"),
        `export const other = workflow({ name: "invoice", run: async () => {} })\n`
      );
      expect(() => scanWorkflowFiles(root)).toThrow(
        'duplicate workflow name "invoice"'
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("rejects leftover *.workflow.ts files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-wf-legacy-"));
    fs.writeFileSync(
      path.join(root, "invoice.workflow.ts"),
      `export const invoice = workflow({ name: "invoice", run: async () => {} })\n`
    );
    try {
      expect(() => scanWorkflowFiles(root)).toThrow("*.workflow.ts");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("workflow codegen", () => {
  test("client stub exposes start status send", () => {
    const code = generateWorkflowClientStub({
      exports: [
        {
          binding: "INVOICE",
          className: "InvoiceWorkflow",
          exportName: "invoice",
          name: "invoice",
        },
      ],
    });
    expect(code).toContain("// oxidejs:workflow-stub");
    expect(code).toContain("start: wrapClientRpc");
    expect(code).toContain("status: wrapClientRpc");
    expect(code).toContain("send: wrapClientRpc");
    expect(code).toContain('client["invoice"]');
  });

  test("classes module extends WorkflowEntrypoint", () => {
    const code = generateWorkflowClassesModule([
      {
        abs: "/app/src/invoice.server.ts",
        exports: [
          {
            binding: "INVOICE",
            className: "InvoiceWorkflow",
            exportName: "invoice",
            name: "invoice",
          },
        ],
        key: "invoice",
      },
    ]);
    expect(code).toContain('from "cloudflare:workers"');
    expect(code).toContain(
      "export class InvoiceWorkflow extends WorkflowEntrypoint"
    );
    expect(code).toContain("readWorkflowMeta");
    expect(code).toContain("withRequestStore");
    expect(code).toContain("const __ctx = { env: this.env, step };");
    expect(code).toContain("__meta_InvoiceWorkflow.run(event, __ctx)");
  });

  test("actions module registers workflow rpcs", () => {
    const code = generateActionsModule([], {
      workflows: [
        {
          abs: "/app/src/invoice.server.ts",
          exports: [
            {
              binding: "INVOICE",
              className: "InvoiceWorkflow",
              exportName: "invoice",
              name: "invoice",
            },
          ],
          key: "invoice",
        },
      ],
    });
    expect(code).toContain('"invoice.start"');
    expect(code).toContain('"invoice.status"');
    expect(code).toContain('"invoice.send"');
    expect(code).toContain("WORKFLOW_META");
    expect(code).toContain(".start.apply");
  });

  test("client actions group includes workflow tags", () => {
    const code = generateActionsClientModule(
      [],
      [
        {
          abs: "/app/src/invoice.server.ts",
          exports: [
            {
              binding: "INVOICE",
              className: "InvoiceWorkflow",
              exportName: "invoice",
              name: "invoice",
            },
          ],
          key: "invoice",
        },
      ]
    );
    expect(code).toContain('"invoice.start"');
  });

  test("worker wrapper re-exports workflow classes", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", {
      hasActions: true,
      preset: "worker",
      workflowClassNames: ["InvoiceWorkflow"],
    });
    expect(code).toContain(
      'export { InvoiceWorkflow } from "virtual:oxide/workflows"'
    );
  });

  test("worker wrapper skips workflow exports on fetch", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", {
      hasActions: true,
      preset: "fetch",
      workflowClassNames: ["InvoiceWorkflow"],
    });
    expect(code).not.toContain("virtual:oxide/workflows");
  });

  test("rejects workflow name colliding with a module that exports actions", () => {
    expect(() =>
      assertWorkflowActionCollisions(
        [{ exports: ["charge"], key: "invoice" }],
        [
          {
            abs: "/x",
            exports: [
              {
                binding: "INVOICE",
                className: "InvoiceWorkflow",
                exportName: "invoice",
                name: "invoice",
              },
            ],
            key: "invoice",
          },
        ]
      )
    ).toThrow("collides with server module key");
  });

  test("allows workflow-only *.server.ts with matching module key", () => {
    expect(() =>
      assertWorkflowActionCollisions(
        [{ exports: [], key: "invoice" }],
        [
          {
            abs: "/x/invoice.server.ts",
            exports: [
              {
                binding: "INVOICE",
                className: "InvoiceWorkflow",
                exportName: "invoice",
                name: "invoice",
              },
            ],
            key: "invoice",
          },
        ]
      )
    ).not.toThrow();
  });
});

describe("workflow runtime", () => {
  test("start create status send against env binding", async () => {
    const statuses = new Map<string, { status: string }>();
    const events: { payload?: unknown; type: string }[] = [];
    const env = {
      INVOICE: {
        create: ({ id, params }: { id?: string; params?: unknown }) => {
          const instanceId = id ?? "auto";
          statuses.set(instanceId, { status: "queued" });
          expect(params).toEqual({ orderId: "o1" });
          return Promise.resolve({ id: instanceId });
        },
        get: (id: string) =>
          Promise.resolve({
            sendEvent: (event: { payload?: unknown; type: string }) => {
              events.push(event);
              return Promise.resolve();
            },
            status: () =>
              Promise.resolve(statuses.get(id) ?? { status: "unknown" }),
          }),
      },
    };
    const invoice = workflow({
      name: "invoice",
      payload: Schema.Struct({ orderId: Schema.String }),
      run: () => Promise.resolve({ ok: true }),
    });
    await withRequestStore(
      {
        // SAFETY: test fixture stubs Workflow binding methods, not OxidejsJson.
        env: env as never,
        req: new Request("http://localhost/"),
      },
      async () => {
        const { id } = await invoice.start(
          { orderId: "o1" },
          { idempotencyKey: "job-1" }
        );
        expect(id).toBe("job-1");
        expect(await invoice.status(id)).toEqual({ status: "queued" });
        await invoice.send(id, { payload: { ok: true }, type: "paid" });
        expect(events).toEqual([{ payload: { ok: true }, type: "paid" }]);
      }
    );
  });

  test("start is idempotent when create reports id already exists", async () => {
    let creates = 0;
    const env = {
      INVOICE: {
        create: ({ id }: { id?: string }) => {
          creates += 1;
          if (creates > 1) {
            return Promise.reject(
              new Error(`Workflow instance with id "${id}" already exists`)
            );
          }
          return Promise.resolve({ id: id ?? "auto" });
        },
        get: () =>
          Promise.resolve({
            sendEvent: () => Promise.resolve(),
            status: () => Promise.resolve({ status: "running" }),
          }),
      },
    };
    const invoice = workflow({
      name: "invoice",
      run: () => Promise.resolve(),
    });
    await withRequestStore(
      {
        // SAFETY: test fixture stubs Workflow binding methods.
        env: env as never,
        req: new Request("http://localhost/"),
      },
      async () => {
        // SAFETY: no payload schema — empty start exercises idempotent create.
        expect(
          await invoice.start(undefined as never, { idempotencyKey: "job-1" })
        ).toEqual({ id: "job-1" });
        // SAFETY: same as above — second start must reuse the existing id.
        expect(
          await invoice.start(undefined as never, { idempotencyKey: "job-1" })
        ).toEqual({ id: "job-1" });
        expect(creates).toBe(2);
      }
    );
  });

  test("start throws when binding is missing", async () => {
    const invoice = workflow({
      name: "invoice",
      run: () => Promise.resolve(),
    });
    await expect(
      withRequestStore({ req: new Request("http://localhost/") }, () =>
        // SAFETY: no payload schema — empty start exercises missing binding.
        invoice.start(undefined as never)
      )
    ).rejects.toThrow('workflow binding "INVOICE" is missing');
  });

  test("status returns not_found when get throws instance missing", async () => {
    const env = {
      INVOICE: {
        create: () => Promise.resolve({ id: "x" }),
        get: () => Promise.reject(new Error("instance.not_found")),
      },
    };
    const invoice = workflow({
      name: "invoice",
      run: () => Promise.resolve(),
    });
    await withRequestStore(
      {
        // SAFETY: test fixture stubs Workflow binding methods.
        env: env as never,
        req: new Request("http://localhost/"),
      },
      async () => {
        expect(await invoice.status("missing")).toEqual({
          status: "not_found",
        });
      }
    );
  });

  test("status normalizes null error/output and surfaces host throws", async () => {
    const env = {
      INVOICE: {
        create: () => Promise.resolve({ id: "x" }),
        get: (id: string) => {
          if (id === "boom") {
            return Promise.reject(
              new Error("workflows.api.error.internal_server")
            );
          }
          return Promise.resolve({
            status: () =>
              Promise.resolve({
                error: null,
                output: null,
                rollback: null,
                status: "running",
              }),
          });
        },
      },
    };
    const invoice = workflow({
      name: "invoice",
      run: () => Promise.resolve(),
    });
    await withRequestStore(
      {
        // SAFETY: test fixture stubs Workflow binding methods.
        env: env as never,
        req: new Request("http://localhost/"),
      },
      async () => {
        expect(await invoice.status("ok")).toEqual({ status: "running" });
        expect(await invoice.status("boom")).toEqual({
          error: {
            message: "Error workflows.api.error.internal_server",
          },
          status: "unknown",
        });
      }
    );
  });
});

describe("wrangler workflows merge", () => {
  test("merges scanned workflows into durable bindings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-wf-emit-"));
    fs.writeFileSync(
      path.join(root, "invoice.server.ts"),
      `export const invoice = workflow({ name: "invoice", run: async () => {} })\n`
    );
    try {
      const config: DurableWranglerConfig = {};
      mergeDurableBindings(config, root);
      expect(config.workflows).toEqual([
        {
          binding: "INVOICE",
          class_name: "InvoiceWorkflow",
          name: "invoice",
        },
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
