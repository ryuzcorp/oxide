import { describe, expect, test } from "bun:test";
/* eslint-disable anti-slop/no-unknown-parameters -- schedule env fixtures are trust-boundary stubs */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Schema } from "effect";

import { generateWorkerWrapper } from "./actions";
import { createEmitState, resolveOptions, tryEmitWranglerConfig } from "./core";
import { queue } from "./queue";
import {
  dispatchSchedule,
  readScheduleMeta,
  schedule,
  scheduleTickId,
} from "./schedule";
import {
  assertScheduleCollisions,
  generateScheduleHandlerModule,
  parseScheduleExports,
  resolveScheduleRefs,
  scanScheduleFiles,
  scheduleWranglerCrons,
} from "./schedule-build";
import { workflow } from "./workflow";
import { parseWorkflowExports } from "./workflow-build";
import type { WorkflowModule } from "./workflow-build";

describe("scheduleTickId", () => {
  test("joins name and scheduledTime", () => {
    expect(scheduleTickId("nightly", 1_700_000_000_000)).toBe(
      "nightly:1700000000000"
    );
  });
});

describe("parseScheduleExports", () => {
  test("reads name cron workflow", () => {
    expect(
      parseScheduleExports(`
        export const nightly = schedule({
          name: "nightly",
          cron: "0 3 * * *",
          workflow: invoice,
        })
      `)
    ).toEqual([
      {
        cron: "0 3 * * *",
        exportName: "nightly",
        name: "nightly",
        queueBinding: "",
        queueName: "",
        queueRef: "",
        target: "workflow",
        workflowBinding: "",
        workflowName: "",
        workflowRef: "invoice",
      },
    ]);
  });

  test("requires exactly one target", () => {
    expect(() =>
      parseScheduleExports(
        `export const bad = schedule({ name: "bad", cron: "0 * * * *" })`
      )
    ).toThrow("exactly one of workflow, queue, or handle");
  });

  test("rejects non-literal cron and shorthand workflow", () => {
    expect(() =>
      parseScheduleExports(
        `export const bad = schedule({ name: "bad", cron: CRON, workflow: demo })`
      )
    ).toThrow("cron: must be a string literal");
    expect(() =>
      parseScheduleExports(
        `export const bad = schedule({ name: "bad", cron: "0 * * * *", workflow })`
      )
    ).toThrow("object shorthand");
  });
});

describe("scan + resolve", () => {
  test("resolves workflow refs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-sched-"));
    fs.writeFileSync(
      path.join(root, "demo.server.ts"),
      `export const demo = workflow({ name: "demo", run: async () => {} })
export const hourly = schedule({ name: "hourly", cron: "0 * * * *", workflow: demo })\n`
    );
    const schedules = scanScheduleFiles(root);
    const workflows: WorkflowModule[] = [
      {
        abs: path.join(root, "demo.server.ts"),
        exports: parseWorkflowExports(
          fs.readFileSync(path.join(root, "demo.server.ts"), "utf-8")
        ),
        key: "demo",
      },
    ];
    resolveScheduleRefs(schedules, workflows, []);
    expect(schedules[0]?.exports[0]?.workflowBinding).toBe("DEMO");
    expect(scheduleWranglerCrons(schedules)).toEqual(["0 * * * *"]);
  });
});

describe("schedule codegen", () => {
  test("handler module dispatches schedules", () => {
    const code = generateScheduleHandlerModule([
      {
        abs: "/app/src/demo.server.ts",
        exports: [
          {
            cron: "0 * * * *",
            exportName: "hourly",
            name: "hourly",
            queueBinding: "",
            queueName: "",
            queueRef: "",
            target: "workflow",
            workflowBinding: "DEMO",
            workflowName: "demo",
            workflowRef: "demo",
          },
        ],
        key: "demo",
      },
    ]);
    expect(code).toContain("dispatchSchedule");
    expect(code).toContain("handleSchedule");
  });

  test("worker wrapper attaches scheduled when hasSchedules", () => {
    const code = generateWorkerWrapper("/app/src/server.ts", {
      hasActions: true,
      hasSchedules: true,
      preset: "worker",
    });
    expect(code).toContain('from "virtual:oxide/schedules"');
    expect(code).toContain("async scheduled(controller, env, ctx)");
  });

  test("rejects schedule name colliding with workflow", () => {
    expect(() =>
      assertScheduleCollisions(
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
        [],
        [
          {
            abs: "/y",
            exports: [
              {
                cron: "0 * * * *",
                exportName: "demo",
                name: "demo",
                queueBinding: "",
                queueName: "",
                queueRef: "",
                target: "workflow",
                workflowBinding: "DEMO",
                workflowName: "demo",
                workflowRef: "demo",
              },
            ],
            key: "sched",
          },
        ]
      )
    ).toThrow("collides with workflow name");
  });
});

describe("schedule runtime", () => {
  test("starts workflow with tick id", async () => {
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
    const demo = workflow({
      name: "demo",
      payload: Schema.Struct({ message: Schema.String }),
      run: () => Promise.resolve(),
    });
    const hourly = schedule({
      cron: "0 * * * *",
      name: "hourly",
      params: { message: "tick" },
      workflow: demo,
    });
    expect(readScheduleMeta(hourly)?.workflowBinding).toBe("DEMO");
    const meta = readScheduleMeta(hourly);
    expect(meta).toBeDefined();
    await dispatchSchedule(
      meta ? [meta] : [],
      { cron: "0 * * * *", scheduledTime: 42 },
      env,
      {}
    );
    expect(created).toEqual([{ id: "hourly:42", params: { message: "tick" } }]);
  });

  test("enqueues via queue target without producerStart by default", async () => {
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
      },
    };
    const demo = workflow({
      name: "demo",
      payload: Schema.Struct({ message: Schema.String }),
      run: () => Promise.resolve(),
    });
    const demos = queue({ name: "demos", workflow: demo });
    const hourly = schedule({
      cron: "0 * * * *",
      name: "hourly",
      params: { message: "q" },
      queue: demos,
    });
    const meta = readScheduleMeta(hourly);
    expect(meta?.queueBinding).toBe("DEMOS");
    expect(meta?.workflowBinding).toBe("DEMO");
    expect(meta?.producerStart).toBeUndefined();
    expect(meta).toBeDefined();
    await dispatchSchedule(
      meta ? [meta] : [],
      { cron: "0 * * * *", scheduledTime: 7 },
      env,
      {}
    );
    expect(sent).toEqual([
      {
        id: "hourly:7",
        oxide: "oxidejs.queue",
        payload: { message: "q" },
      },
    ]);
    expect(created).toEqual([]);
  });

  test("schedule→queue producerStart starts workflow from the tick", async () => {
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
    const hourly = schedule({
      cron: "0 * * * *",
      name: "hourly",
      params: { message: "q" },
      queue: demos,
    });
    const meta = readScheduleMeta(hourly);
    expect(meta?.producerStart).toBe(true);
    expect(meta).toBeDefined();
    await dispatchSchedule(
      meta ? [meta] : [],
      { cron: "0 * * * *", scheduledTime: 7 },
      env,
      {}
    );
    expect(sent).toHaveLength(1);
    expect(created).toEqual([{ id: "hourly:7", params: { message: "q" } }]);
  });

  test("handle escape", async () => {
    let seen = "";
    const hourly = schedule({
      cron: "0 * * * *",
      handle: (event) => {
        seen = event.name;
      },
      name: "hourly",
    });
    const meta = readScheduleMeta(hourly);
    expect(meta).toBeDefined();
    await dispatchSchedule(
      meta ? [meta] : [],
      { cron: "0 * * * *", scheduledTime: 1 },
      {},
      {}
    );
    expect(seen).toBe("hourly");
  });
});

describe("wrangler triggers emit", () => {
  test("merges scanned schedules into wrangler.jsonc", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-sched-emit-"));
    const outDir = path.join(root, "dist");
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, "server.js"), "export default {}\n");
    fs.writeFileSync(
      path.join(root, "demo.server.ts"),
      `export const demo = workflow({ name: "demo", run: async () => {} })
export const hourly = schedule({ name: "hourly", cron: "0 * * * *", workflow: demo })\n`
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
        triggers: { crons: string[] };
        workflows: { binding: string; name: string }[];
      };
      expect(json.workflows.map((w) => w.name)).toEqual(["demo"]);
      expect(json.triggers).toEqual({ crons: ["0 * * * *"] });
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
