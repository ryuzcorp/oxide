import { afterEach, describe, expect, test, vi } from "bun:test";

import * as Effect from "effect/Effect";

import { deferred } from "./deferred";
import {
  isolateOnce,
  isolateOnceEffect,
  IsolateOnceTimeoutError,
} from "./isolate-once";

afterEach(() => {
  vi.useRealTimers();
});

describe("isolateOnce", () => {
  test("concurrent callers share one pass", async () => {
    vi.useFakeTimers();
    const gate = deferred<true>();
    let calls = 0;
    const run = isolateOnce(
      async () => {
        calls += 1;
        await gate.promise;
        return "value";
      },
      { timeout: 1000, wait: 1000 }
    );

    const results = Promise.all([run(), run(), run()]);
    expect(calls).toBe(1);

    gate.resolve(true);
    expect(await results).toEqual(["value", "value", "value"]);
  });

  test("success caches for the isolate", async () => {
    let calls = 0;
    const run = isolateOnce(() => {
      calls += 1;
      return calls;
    });

    expect(await run()).toBe(1);
    expect(await run()).toBe(1);
    expect(calls).toBe(1);
  });

  test("a failed pass clears so the next caller retries", async () => {
    let calls = 0;
    const run = isolateOnce(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve("ok");
    });

    await expect(run()).rejects.toThrow("boom");
    expect(await run()).toBe("ok");
    expect(calls).toBe(2);
  });

  test("a timed-out pass rejects and clears so the next caller retries", async () => {
    vi.useFakeTimers();
    const gate = deferred<string>();
    let calls = 0;
    const run = isolateOnce(
      () => {
        calls += 1;
        return calls === 1 ? gate.promise : Promise.resolve("ok");
      },
      { timeout: 20, wait: 1000 }
    );

    const first = run();
    vi.advanceTimersByTime(20);
    await expect(first).rejects.toBeInstanceOf(IsolateOnceTimeoutError);
    expect(await run()).toBe("ok");
    expect(calls).toBe(2);
    gate.resolve("late");
  });

  test("the caller that starts a pass is not bounded by wait", async () => {
    vi.useFakeTimers();
    const gate = deferred<string>();
    let calls = 0;
    const run = isolateOnce(
      () => {
        calls += 1;
        return gate.promise;
      },
      { timeout: 1000, wait: 10 }
    );

    const owner = run();
    vi.advanceTimersByTime(100);
    expect(calls).toBe(1);

    gate.resolve("slow");
    expect(await owner).toBe("slow");
  });

  test("a waiter abandons an orphaned pass after wait and runs its own", async () => {
    vi.useFakeTimers();
    const first = deferred<string>();
    let calls = 0;
    const run = isolateOnce<string, { id: number }>(
      () => {
        calls += 1;
        return calls === 1 ? first.promise : Promise.resolve("second");
      },
      { timeout: 1000, wait: 20 }
    );

    const key = { id: 1 };
    const owner = run(key);
    const waiter = run(key);
    vi.advanceTimersByTime(20);

    expect(await waiter).toBe("second");
    expect(calls).toBe(2);

    first.resolve("first");
    expect(await owner).toBe("first");
  });

  test("keys isolate passes by object", async () => {
    let calls = 0;
    const run = isolateOnce((key: { id: number }) => {
      calls += 1;
      return key.id;
    });
    const a = { id: 1 };
    const b = { id: 2 };

    expect(await run(a)).toBe(1);
    expect(await run(a)).toBe(1);
    expect(await run(b)).toBe(2);
    expect(calls).toBe(2);
  });

  test("reset forgets a cached success so the next call runs again", async () => {
    let calls = 0;
    const run = isolateOnce(() => {
      calls += 1;
      return calls;
    });

    expect(await run()).toBe(1);
    run.reset();
    expect(await run()).toBe(2);
    expect(await run()).toBe(2);
  });

  test("reset during a pass keeps its awaiting callers on that pass", async () => {
    const gate = deferred<true>();
    let calls = 0;
    const run = isolateOnce(async () => {
      calls += 1;
      const n = calls;
      if (n === 1) {
        await gate.promise;
      }
      return n;
    });

    const first = run();
    run.reset();
    const second = run();
    gate.resolve(true);
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    // The reset slot now holds the second pass; the first must not clobber it.
    expect(await run()).toBe(2);
  });

  test("reset with a key only forgets that key's pass", async () => {
    const a = { id: 1 };
    const b = { id: 2 };
    let calls = 0;
    const run = isolateOnce((key: { id: number }) => {
      calls += 1;
      return `${key.id}:${calls}`;
    });

    expect(await run(a)).toBe("1:1");
    expect(await run(b)).toBe("2:2");
    run.reset(a);
    expect(await run(a)).toBe("1:3");
    expect(await run(b)).toBe("2:2");
  });
});

describe("isolateOnceEffect", () => {
  test("wraps a shared pass in an Effect", async () => {
    let calls = 0;
    const run = isolateOnceEffect(() => {
      calls += 1;
      return "value";
    });

    const results = await Effect.runPromise(Effect.all([run(), run()]));
    expect(results).toEqual(["value", "value"]);
    expect(calls).toBe(1);
  });
});
