import { describe, expect, test } from "bun:test";
/* eslint-disable anti-slop/no-unknown-parameters -- queue env fixtures are trust-boundary stubs */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Schema } from "effect";

import {
  generateActionsClientModule,
  generateActionsModule,
  generateWorkerWrapper,
} from "./actions";
import { createEmitState, resolveOptions, tryEmitWranglerConfig } from "./core";
import {
  dispatchQueueBatch,
  queue,
  readQueueMeta,
  toQueueBinding,
} from "./queue";
import {
  assertQueueCollisions,
  generateQueueHandlerModule,
  parseQueueExports,
  queueWranglerEntries,
  resolveQueueWorkflowRefs,
  scanQueueFiles,
} from "./queue-build";
import { withRequestStore } from "./request-store";
import { workflow } from "./workflow";
import type { WorkflowModule } from "./workflow-build";
import { parseWorkflowExports } from "./workflow-build";

describe("queue naming", () => {
  test("toQueueBinding upper-snakes names", () => {
    expect(toQueueBinding("invoices")).toBe("INVOICES");
    expect(toQueueBinding("orderEvents")).toBe("ORDER_EVENTS");
  });
});

describe("parseQueueExports", () => {
  test("reads name binding workflow and batch props", () => {
    const exports = parseQueueExports(`
      export const invoices = queue({
        name: "invoices",
        binding: "INVOICES_Q",
        workflow: invoice,
        maxBatchSize: 5,
        maxBatchTimeout: 2,
        maxRetries: 3,
      })
    `);
    expect(exports).toEqual([
      {
        binding: "INVOICES_Q",
        exportName: "invoices",
        maxBatchSize: 5,
        maxBatchTimeout: 2,
        maxRetries: 3,
        name: "invoices",
        workflowBinding: "",
        workflowName: "",
        workflowRef: "invoice",
      },
    ]);
  });

  test("defaults name and binding; requires workflow", () => {
    expect(
      parseQueueExports(
        `export const invoices = queue({ workflow: "invoice" })`
      )
    ).toEqual([
      {
        binding: "INVOICES",
        exportName: "invoices",
        name: "invoices",
        workflowBinding: "",
        workflowName: "",
        workflowRef: "invoice",
      },
    ]);
    expect(() =>
      parseQueueExports(`export const invoices = queue({ name: "invoices" })`)
    ).toThrow("requires workflow");
  });

  test("rejects shorthand workflow and non-literal name", () => {
    expect(() =>
      parseQueueExports(
        `export const invoices = queue({ name: "invoices", workflow })`
      )
    ).toThrow("object shorthand");
    expect(() =>
      parseQueueExports(
        `export const invoices = queue({ name: queueName, workflow: invoice })`
      )
    ).toThrow("name: must be a string literal");
  });
});

describe("scanQueueFiles + resolve", () => {
  test("resolves workflow refs and rejects unknown", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-q-scan-"));
    fs.writeFileSync(
      path.join(root, "demo.server.ts"),
      `export const demo = workflow({ name: "demo", run: async () => {} })
export const demos = queue({ name: "demos", workflow: demo })\n`
    );
    const queues = scanQueueFiles(root);
    const workflows: WorkflowModule[] = [
      {
        abs: path.join(root, "demo.server.ts"),
        exports: parseWorkflowExports(
          fs.readFileSync(path.join(root, "demo.server.ts"), "utf-8")
        ),
        key: "demo",
      },
    ];
    resolveQueueWorkflowRefs(queues, workflows);
    expect(queues[0]?.exports[0]?.workflowName).toBe("demo");
    expect(queues[0]?.exports[0]?.workflowBinding).toBe("DEMO");

    fs.writeFileSync(
      path.join(root, "bad.server.ts"),
      `export const orphan = queue({ name: "orphan", workflow: "missing" })\n`
    );
    const bad = scanQueueFiles(root);
    expect(() => resolveQueueWorkflowRefs(bad, workflows)).toThrow(
      'workflow "missing" not found'
    );
  });
});

describe("queue codegen", () => {
  const queueMod = {
    abs: "/app/src/demo.server.ts",
    exports: [
      {
        binding: "DEMOS",
        exportName: "demos",
        name: "demos",
        workflowBinding: "DEMO",
        workflowName: "demo",
        workflowRef: "demo",
      },
    ],
    key: "demo",
  };

  test("actions module registers queue rpcs", () => {
    const code = generateActionsModule([], {
      queues: [queueMod],
      workflows: [],
    });
    expect(code).toContain('"demos.send"');
    expect(code).toContain('"demos.sendBatch"');
    expect(code).toContain("QUEUE_META");
    expect(code).toContain(".send.apply");
    expect(code).toContain("__qpayload");
    expect(code).toContain("__queueSendOpts");
  });

  test("client actions group includes queue tags", () => {
    const code = generateActionsClientModule([], [], [queueMod]);
    expect(code).toContain('"demos.send"');
    expect(code).toContain('"demos.sendBatch"');
  });

  test("queue handler module dispatches by queue name", () => {
    const code = generateQueueHandlerModule([queueMod]);
    expect(code).toContain("dispatchQueueBatch");
    expect(code).toContain('"demos"');
    expect(code).toContain("handleQueue");
  });

  test("worker wrapper attaches queue handler when hasQueues", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", {
      hasActions: true,
      hasQueues: true,
      preset: "worker",
    });
    expect(code).toContain('from "virtual:oxide/queues"');
    expect(code).toContain("async queue(batch, env, ctx)");
  });

  test("worker wrapper omits queue when hasQueues is false", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", {
      hasActions: true,
      preset: "worker",
    });
    expect(code).not.toContain("virtual:oxide/queues");
    expect(code).not.toContain("async queue(");
  });

  test("rejects queue name colliding with workflow name", () => {
    expect(() =>
      assertQueueCollisions(
        [],
        [
          {
            abs: "/x",
            exports: [
              {
                binding: "DEMO",
                className: "DemoWorkflow",
                exportName: "demo",
                name: "demo",
              },
            ],
            key: "demo",
          },
        ],
        [
          {
            abs: "/y",
            exports: [
              {
                binding: "DEMO",
                exportName: "demo",
                name: "demo",
                workflowBinding: "DEMO",
                workflowName: "demo",
                workflowRef: "demo",
              },
            ],
            key: "demos",
          },
        ]
      )
    ).toThrow("collides with workflow name");
  });

  test("rejects queue name colliding with action module key", () => {
    expect(() =>
      assertQueueCollisions(
        [{ exports: ["list"], key: "demos" }],
        [],
        [
          {
            abs: "/y",
            exports: [
              {
                binding: "DEMOS",
                exportName: "demos",
                name: "demos",
                workflowBinding: "DEMO",
                workflowName: "demo",
                workflowRef: "demo",
              },
            ],
            key: "demos",
          },
        ]
      )
    ).toThrow("collides with server module key");
  });
});

describe("queue runtime", () => {
  test("send / sendBatch against env binding", async () => {
    const sent: unknown[] = [];
    const batches: unknown[] = [];
    const env = {
      DEMOS: {
        send: (body: unknown) => {
          sent.push(body);
          return Promise.resolve();
        },
        sendBatch: (messages: Iterable<{ body: unknown }>) => {
          batches.push([...messages]);
          return Promise.resolve();
        },
      },
    };
    const demo = workflow({
      name: "demo",
      payload: Schema.Struct({ message: Schema.String }),
      run: () => Promise.resolve(),
    });
    const demos = queue({
      name: "demos",
      workflow: demo,
    });
    expect(readQueueMeta(demos)?.workflowBinding).toBe("DEMO");
    expect(readQueueMeta(demos)?.payload).toBeDefined();
    await withRequestStore(
      {
        // SAFETY: test fixture stubs Queue binding methods.
        env: env as never,
        req: new Request("http://localhost/"),
      },
      async () => {
        const { id } = await demos.send(
          { message: "hi" },
          { idempotencyKey: "job-1" }
        );
        expect(id).toBe("job-1");
        expect(sent).toEqual([
          {
            id: "job-1",
            oxide: "oxidejs.queue",
            payload: { message: "hi" },
          },
        ]);
        const { ids } = await demos.sendBatch([
          { body: { message: "a" }, idempotencyKey: "job-2" },
        ]);
        expect(ids).toEqual(["job-2"]);
        expect(batches).toEqual([
          [
            {
              body: {
                id: "job-2",
                oxide: "oxidejs.queue",
                payload: { message: "a" },
              },
              contentType: "json",
            },
          ],
        ]);
      }
    );
  });

  test("send does not producer-start by default", async () => {
    const created: unknown[] = [];
    const env = {
      DEMO: {
        create: (opts?: { id?: string; params?: unknown }) => {
          created.push(opts ?? {});
          return Promise.resolve({ id: opts?.id });
        },
        get: (id: string) => Promise.resolve({ id }),
      },
      DEMOS: {
        send: () => Promise.resolve(),
        sendBatch: () => Promise.resolve(),
      },
    };
    const demo = workflow({
      name: "demo",
      payload: Schema.Struct({ message: Schema.String }),
      run: () => Promise.resolve(),
    });
    const demos = queue({ name: "demos", workflow: demo });
    await withRequestStore(
      {
        // SAFETY: test fixture stubs Queue + Workflow bindings.
        env: env as never,
        req: new Request("http://localhost/"),
      },
      async () => {
        await demos.send({ message: "hi" }, { idempotencyKey: "job-default" });
        expect(created).toEqual([]);
      }
    );
  });

  test("send starts workflow from producer when producerStart is true", async () => {
    const sent: unknown[] = [];
    const created: { id?: string; params?: unknown }[] = [];
    const env = {
      DEMO: {
        create: (opts?: { id?: string; params?: unknown }) => {
          created.push(opts ?? {});
          return Promise.resolve({ id: opts?.id });
        },
        get: (id: string) => Promise.resolve({ id }),
      },
      DEMOS: {
        send: (body: unknown) => {
          sent.push(body);
          return Promise.resolve();
        },
        sendBatch: () => Promise.resolve(),
      },
    };
    const demo = workflow({
      name: "demo",
      payload: Schema.Struct({ message: Schema.String }),
      run: () => Promise.resolve(),
    });
    const demos = queue({
      name: "demos",
      producerStart: true,
      workflow: demo,
    });
    await withRequestStore(
      {
        // SAFETY: test fixture stubs Queue + Workflow bindings.
        env: env as never,
        req: new Request("http://localhost/"),
      },
      async () => {
        const { id } = await demos.send(
          { message: "hi" },
          { idempotencyKey: "job-prod" }
        );
        expect(id).toBe("job-prod");
        expect(sent).toHaveLength(1);
        expect(created).toEqual([
          { id: "job-prod", params: { message: "hi" } },
        ]);
      }
    );
  });

  test("producerStart create failure after enqueue does not fail send", async () => {
    const env = {
      DEMO: {
        create: () => Promise.reject(new Error("create failed")),
        get: (id: string) => Promise.resolve({ id }),
      },
      DEMOS: {
        send: () => Promise.resolve(),
        sendBatch: () => Promise.resolve(),
      },
    };
    const demo = workflow({
      name: "demo",
      payload: Schema.Struct({ message: Schema.String }),
      run: () => Promise.resolve(),
    });
    const demos = queue({
      name: "demos",
      producerStart: true,
      workflow: demo,
    });
    await withRequestStore(
      {
        // SAFETY: test fixture stubs Queue + Workflow bindings.
        env: env as never,
        req: new Request("http://localhost/"),
      },
      async () => {
        const { id } = await demos.send(
          { message: "hi" },
          { idempotencyKey: "job-soft" }
        );
        expect(id).toBe("job-soft");
      }
    );
  });

  test("send with delaySeconds does not producer-start the workflow", async () => {
    const created: unknown[] = [];
    const env = {
      DEMO: {
        create: (opts?: { id?: string; params?: unknown }) => {
          created.push(opts ?? {});
          return Promise.resolve({ id: opts?.id });
        },
        get: (id: string) => Promise.resolve({ id }),
      },
      DEMOS: {
        send: () => Promise.resolve(),
        sendBatch: () => Promise.resolve(),
      },
    };
    const demo = workflow({
      name: "demo",
      payload: Schema.Struct({ message: Schema.String }),
      run: () => Promise.resolve(),
    });
    const demos = queue({
      name: "demos",
      producerStart: true,
      workflow: demo,
    });
    await withRequestStore(
      {
        // SAFETY: test fixture stubs Queue + Workflow bindings.
        env: env as never,
        req: new Request("http://localhost/"),
      },
      async () => {
        await demos.send(
          { message: "later" },
          { delaySeconds: 30, idempotencyKey: "job-delay" }
        );
        expect(created).toEqual([]);
      }
    );
  });

  test("dispatchQueueBatch starts workflow with envelope id", async () => {
    const created: { id?: string; params?: unknown }[] = [];
    const env = {
      DEMO: {
        create: (opts?: { id?: string; params?: unknown }) => {
          created.push(opts ?? {});
          return Promise.resolve({ id: opts?.id });
        },
        get: (id: string) => Promise.resolve({ id }),
      },
    };
    const meta = {
      binding: "DEMOS",
      name: "demos",
      workflowBinding: "DEMO",
      workflowName: "demo",
    };
    await dispatchQueueBatch(
      meta,
      {
        ackAll: () => {},
        messages: [
          {
            ack: () => {},
            body: {
              id: "job-9",
              oxide: "oxidejs.queue",
              payload: { message: "x" },
            },
            id: "msg-1",
            retry: () => {},
            timestamp: new Date(),
          },
        ],
        queue: "demos",
        retryAll: () => {},
      },
      env,
      {}
    );
    expect(created).toEqual([{ id: "job-9", params: { message: "x" } }]);
  });

  test("dispatchQueueBatch falls back to CF message id for raw bodies", async () => {
    const created: { id?: string; params?: unknown }[] = [];
    const env = {
      DEMO: {
        create: (opts?: { id?: string; params?: unknown }) => {
          created.push(opts ?? {});
          return Promise.resolve({ id: opts?.id });
        },
        get: (id: string) => Promise.resolve({ id }),
      },
    };
    await dispatchQueueBatch(
      {
        binding: "DEMOS",
        name: "demos",
        workflowBinding: "DEMO",
        workflowName: "demo",
      },
      {
        ackAll: () => {},
        messages: [
          {
            ack: () => {},
            body: { message: "x" },
            id: "msg-1",
            retry: () => {},
            timestamp: new Date(),
          },
        ],
        queue: "demos",
        retryAll: () => {},
      },
      env,
      {}
    );
    expect(created).toEqual([{ id: "msg-1", params: { message: "x" } }]);
  });

  test("dispatchQueueBatch reuses existing workflow ids on create conflict", async () => {
    const created: string[] = [];
    const got: string[] = [];
    const env = {
      DEMO: {
        create: (opts?: { id?: string }) => {
          const id = opts?.id ?? "auto";
          if (created.includes(id)) {
            return Promise.reject(
              new Error(`Workflow instance with id "${id}" already exists`)
            );
          }
          created.push(id);
          return Promise.resolve({ id });
        },
        get: (id: string) => {
          got.push(id);
          return Promise.resolve({ id });
        },
      },
    };
    const batch = {
      ackAll: () => {},
      messages: [
        {
          ack: () => {},
          body: {
            id: "job-9",
            oxide: "oxidejs.queue" as const,
            payload: { message: "x" },
          },
          id: "msg-1",
          retry: () => {},
          timestamp: new Date(),
        },
      ],
      queue: "demos",
      retryAll: () => {},
    };
    const meta = {
      binding: "DEMOS",
      name: "demos",
      workflowBinding: "DEMO",
      workflowName: "demo",
    };
    await dispatchQueueBatch(meta, batch, env, {});
    await dispatchQueueBatch(meta, batch, env, {});
    expect(created).toEqual(["job-9"]);
    expect(got).toEqual(["job-9"]);
  });

  test("dispatchQueueBatch prefers createBatch when available", async () => {
    const batches: unknown[] = [];
    const env = {
      DEMO: {
        create: () => Promise.reject(new Error("should use createBatch")),
        createBatch: (batch: unknown[]) => {
          batches.push(batch);
          return Promise.resolve(batch);
        },
        get: (id: string) => Promise.resolve({ id }),
      },
    };
    await dispatchQueueBatch(
      {
        binding: "DEMOS",
        name: "demos",
        workflowBinding: "DEMO",
        workflowName: "demo",
      },
      {
        ackAll: () => {},
        messages: [
          {
            ack: () => {},
            body: {
              id: "a",
              oxide: "oxidejs.queue",
              payload: { n: 1 },
            },
            id: "m1",
            retry: () => {},
            timestamp: new Date(),
          },
          {
            ack: () => {},
            body: {
              id: "b",
              oxide: "oxidejs.queue",
              payload: { n: 2 },
            },
            id: "m2",
            retry: () => {},
            timestamp: new Date(),
          },
        ],
        queue: "demos",
        retryAll: () => {},
      },
      env,
      {}
    );
    expect(batches).toEqual([
      [
        { id: "a", params: { n: 1 } },
        { id: "b", params: { n: 2 } },
      ],
    ]);
  });

  test("dispatchQueueBatch uses handle escape", async () => {
    let handled = false;
    await dispatchQueueBatch(
      {
        binding: "DEMOS",
        handle: () => {
          handled = true;
        },
        name: "demos",
        workflowBinding: "DEMO",
        workflowName: "demo",
      },
      {
        ackAll: () => {},
        messages: [],
        queue: "demos",
        retryAll: () => {},
      },
      {},
      {}
    );
    expect(handled).toBe(true);
  });
});

describe("wrangler queues emit", () => {
  test("merges scanned queues into wrangler.jsonc", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-q-emit-"));
    const outDir = path.join(root, "dist");
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, "server.js"), "export default {}\n");
    fs.writeFileSync(
      path.join(root, "demo.server.ts"),
      `export const demo = workflow({ name: "demo", run: async () => {} })
export const demos = queue({ name: "demos", workflow: demo, maxBatchSize: 10 })\n`
    );
    try {
      const resolved = resolveOptions(
        {
          preset: "worker",
          wrangler: {
            compatibility_date: "2026-01-01",
            name: "app",
          },
        },
        root
      );
      const opts = { ...resolved, outDir, root };
      tryEmitWranglerConfig(opts, createEmitState());
      // SAFETY: emitted wrangler.jsonc shape asserted below.
      const json = JSON.parse(
        fs.readFileSync(path.join(outDir, "wrangler.jsonc"), "utf-8")
      ) as {
        queues: {
          consumers: { max_batch_size?: number; queue: string }[];
          producers: { binding: string; queue: string }[];
        };
        workflows: { binding: string; class_name: string; name: string }[];
      };
      expect(json.workflows).toEqual([
        { binding: "DEMO", class_name: "DemoWorkflow", name: "demo" },
      ]);
      expect(json.queues).toEqual({
        consumers: [{ max_batch_size: 10, queue: "demos" }],
        producers: [{ binding: "DEMOS", queue: "demos" }],
      });
      expect(queueWranglerEntries(scanQueueFiles(root)).producers).toEqual([
        { binding: "DEMOS", queue: "demos" },
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
