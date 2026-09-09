import { describe, expect, test } from "bun:test";

import { createMutationQueue } from "./mutation-queue";

describe("createMutationQueue", () => {
  test("passes through successful calls", async () => {
    const queue = createMutationQueue();
    const add = queue.wrap((n: number) => Promise.resolve(n + 1));
    expect(await add(1)).toBe(2);
    expect(queue.pending).toBe(0);
  });

  test("enqueues on transient failure and resolves on flush", async () => {
    const queue = createMutationQueue();
    let fail = true;
    const add = queue.wrap(
      (text: string) => {
        if (fail) {
          return Promise.reject(new Error("SocketCloseError: 1001"));
        }
        return Promise.resolve(text);
      },
      { idempotencyKey: (text) => `add:${text}` }
    );

    const pending = add("milk");
    await Bun.sleep(10);
    expect(queue.pending).toBe(1);

    fail = false;
    await queue.flush();
    expect(await pending).toBe("milk");
    expect(queue.pending).toBe(0);
  });

  test("coalesces duplicate idempotency keys", async () => {
    const queue = createMutationQueue();
    let calls = 0;
    let fail = true;
    const add = queue.wrap(
      () => {
        calls += 1;
        if (fail) {
          return Promise.reject(new Error("SocketCloseError: 1000"));
        }
        return Promise.resolve(calls);
      },
      { idempotencyKey: () => "once" }
    );

    const a = add();
    const b = add();
    await Bun.sleep(10);
    expect(queue.pending).toBe(1);

    fail = false;
    await queue.flush();
    expect(await Promise.all([a, b])).toEqual([2, 2]);
    expect(calls).toBe(2);
  });

  test("forwards idempotencyKey as CallOptions", async () => {
    const queue = createMutationQueue();
    let seen: string | undefined;
    const add = queue.wrap(
      (text: string, opts?: { idempotencyKey?: string }) => {
        seen = opts?.idempotencyKey;
        return Promise.resolve(text);
      },
      { idempotencyKey: (text) => `add:${text}` }
    );
    expect(await add("milk")).toBe("milk");
    expect(seen).toBe("add:milk");
  });

  test("flush retries transient failures with Schedule", async () => {
    const queue = createMutationQueue({
      retries: 3,
      retryBase: "1 millis",
    });
    let attempts = 0;
    const add = queue.wrap(() => {
      attempts += 1;
      if (attempts < 3) {
        return Promise.reject(new Error("SocketCloseError: 1006"));
      }
      return Promise.resolve("ok");
    });

    const pending = add();
    await Bun.sleep(5);
    expect(queue.pending).toBe(1);

    await queue.flush();
    expect(await pending).toBe("ok");
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(queue.pending).toBe(0);
  });
});
