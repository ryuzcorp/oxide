import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bindings, exports, triggers } from "@cloudflare/config";

import { oxideDurable } from "./cf";
import { mergeDurableBindings } from "./core";
import type { DurableWranglerConfig } from "./core";

interface TempRoot {
  cleanup: () => void;
  root: string;
}

const DEMO_SOURCE = `
import { queue, schedule, workflow } from "oxidejs";
export const demo = workflow({
  name: "demo",
  run: async () => {},
});
export const demos = queue({
  maxBatchSize: 10,
  name: "demos",
  workflow: demo,
});
export const demoHourly = schedule({
  cron: "0 * * * *",
  name: "demo-hourly",
  workflow: demo,
});
`;

const makeRoot = function makeRoot(files: Record<string, string>): TempRoot {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-cf-"));
  for (const [name, source] of Object.entries(files)) {
    const abs = path.join(root, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, source);
  }
  return {
    cleanup: () => fs.rmSync(root, { force: true, recursive: true }),
    root,
  };
};

describe("oxideDurable", () => {
  test("returns empty fragments when nothing is scanned", () => {
    const { cleanup, root } = makeRoot({});
    try {
      expect(oxideDurable(root)).toEqual({
        env: {},
        exports: {},
        triggers: [],
      });
    } finally {
      cleanup();
    }
  });

  test("maps scanned workflow queue and schedule to config fragments", () => {
    const { cleanup, root } = makeRoot({ "src/demo.server.ts": DEMO_SOURCE });
    try {
      const durable = oxideDurable(root);
      expect(durable.env).toEqual({
        DEMOS: bindings.queue({ name: "demos" }),
      });
      expect(durable.exports).toEqual({
        DemoWorkflow: exports.workflow({ name: "demo" }),
      });
      expect(durable.triggers).toEqual([
        triggers.queue({ maxBatchSize: 10, name: "demos" }),
        triggers.scheduled({ schedule: "0 * * * *" }),
      ]);
    } finally {
      cleanup();
    }
  });

  test("carries the same deploy names as mergeDurableBindings", () => {
    const { cleanup, root } = makeRoot({ "src/demo.server.ts": DEMO_SOURCE });
    try {
      const durable = oxideDurable(root);
      const legacy: DurableWranglerConfig = {};
      mergeDurableBindings(legacy, root);
      expect(legacy.workflows).toEqual([
        { binding: "DEMO", class_name: "DemoWorkflow", name: "demo" },
      ]);
      expect(Object.keys(durable.exports)).toEqual(
        (legacy.workflows ?? []).map((entry) => entry.class_name)
      );
      expect(Object.keys(durable.env)).toEqual(
        (legacy.queues?.producers ?? []).map((entry) => entry.binding)
      );
      expect(legacy.triggers).toEqual({ crons: ["0 * * * *"] });
    } finally {
      cleanup();
    }
  });

  test("rejects duplicate queue bindings while scanning", () => {
    const { cleanup, root } = makeRoot({
      "src/a.server.ts": `
import { queue, workflow } from "oxidejs";
export const demoA = workflow({ name: "demo-a", run: async () => {} });
export const first = queue({ binding: "SAME", name: "first", workflow: demoA });
`,
      "src/b.server.ts": `
import { queue, workflow } from "oxidejs";
export const demoB = workflow({ name: "demo-b", run: async () => {} });
export const second = queue({ binding: "SAME", name: "second", workflow: demoB });
`,
    });
    try {
      expect(() => oxideDurable(root)).toThrow(
        'duplicate queue binding "SAME"'
      );
    } finally {
      cleanup();
    }
  });
});
