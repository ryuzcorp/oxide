import { describe, expect, test } from "bun:test";

import {
  findTopLevelPropKeyIndex,
  hasProp,
  readLiteralStringProp,
  readRefProp,
} from "./durable-scan";

describe("durable-scan top-level props", () => {
  test("ignores nested name inside run return object", () => {
    const inner = `{
      name: "invoice",
      run: () => ({ name: "result" }),
    }`;
    expect(readLiteralStringProp(inner, "name", "workflow")).toBe("invoice");
  });

  test("ignores nested cron inside params", () => {
    const inner = `{
      name: "hourly",
      cron: "0 * * * *",
      params: { cron: "not-a-cron", message: "tick" },
      workflow: demo,
    }`;
    expect(readLiteralStringProp(inner, "cron", "schedule")).toBe("0 * * * *");
  });

  test("ignores nested queue / workflow / handle payload keys", () => {
    const inner = `{
      name: "hourly",
      cron: "0 * * * *",
      params: { queue: "nested", workflow: "nested", handle: "nested" },
      workflow: demo,
    }`;
    expect(hasProp(inner, "queue")).toBe(false);
    expect(hasProp(inner, "handle")).toBe(false);
    expect(readRefProp(inner, "workflow", "schedule")).toBe("demo");
    expect(findTopLevelPropKeyIndex(inner, "queue")).toBe(-1);
  });

  test("still finds top-level queue target", () => {
    const inner = `{
      name: "hourly",
      cron: "0 * * * *",
      queue: demos,
      params: { workflow: "nested" },
    }`;
    expect(readRefProp(inner, "queue", "schedule")).toBe("demos");
    expect(hasProp(inner, "workflow")).toBe(false);
  });
});
