import { describe, expect, test } from "bun:test";
import { Publisher } from "./pubsub";

describe("Publisher", () => {
  test("subscribers receive published payloads", async () => {
    const publisher = new Publisher<{ tick: number }>();
    const sub = publisher.subscribe("tick");
    publisher.publish("tick", 1);
    publisher.publish("tick", 2);
    const out: number[] = [];
    for await (const value of sub) {
      out.push(value);
      if (out.length === 2) await sub.return();
    }
    expect(out).toEqual([1, 2]);
  });

  test("abort signal ends the subscription", async () => {
    const publisher = new Publisher<{ msg: string }>();
    const controller = new AbortController();
    const sub = publisher.subscribe("msg", { signal: controller.signal });
    publisher.publish("msg", "a");
    expect(await sub.next()).toEqual({ value: "a", done: false });
    controller.abort();
    expect((await sub.next()).done).toBe(true);
    publisher.publish("msg", "dropped");
    expect((await sub.next()).done).toBe(true);
  });

  test("events are isolated per name", async () => {
    const publisher = new Publisher<{ a: string; b: string }>();
    const sub = publisher.subscribe("a");
    publisher.publish("b", "nope");
    publisher.publish("a", "yes");
    expect((await sub.next()).value).toBe("yes");
    await sub.return();
  });

  test("once resolves on next publish", async () => {
    const publisher = new Publisher<{ msg: string | null }>();
    const first = publisher.once("msg");
    publisher.publish("msg", null);
    expect(await first).toBeNull();
    // subscriber is gone; publishing again must not throw
    publisher.publish("msg", "b");
  });

  test("once resolves undefined when aborted before any publish", async () => {
    const publisher = new Publisher<{ msg: string }>();
    const controller = new AbortController();
    const p = publisher.once("msg", { signal: controller.signal });
    controller.abort();
    expect(await p).toBeUndefined();
  });

  test("an already-aborted signal does not subscribe", async () => {
    const publisher = new Publisher<{ msg: string }>();
    const controller = new AbortController();
    controller.abort();
    expect(await publisher.once("msg", { signal: controller.signal })).toBeUndefined();
  });

  test("payloads published while consumer awaits are queued in order", async () => {
    const publisher = new Publisher<{ n: number }>();
    const sub = publisher.subscribe("n");
    const received: number[] = [];
    const done = (async () => {
      for await (const value of sub) received.push(value);
    })();
    publisher.publish("n", 1);
    publisher.publish("n", 2);
    await Promise.resolve();
    publisher.publish("n", 3);
    setTimeout(() => sub.return(), 1);
    await done;
    expect(received).toEqual([1, 2, 3]);
  });

  test("multiple subscribers each see every payload", async () => {
    const publisher = new Publisher<{ n: number }>();
    const subA = publisher.subscribe("n");
    const subB = publisher.subscribe("n");
    const gotA: (number | void)[] = [];
    const gotB: (number | void)[] = [];
    publisher.publish("n", 1);
    publisher.publish("n", 2);
    gotA.push((await subA.next()).value);
    gotA.push((await subA.next()).value);
    gotB.push((await subB.next()).value);
    gotB.push((await subB.next()).value);
    expect(gotA).toEqual([1, 2]);
    expect(gotB).toEqual([1, 2]);
    await subA.return();
    await subB.return();
  });

  test("breaking out of for await ends the subscription", async () => {
    const publisher = new Publisher<{ n: number }>();
    const sub = publisher.subscribe("n");
    publisher.publish("n", 1);
    expect((await sub.next()).value).toBe(1);
    await sub.return();
    publisher.publish("n", 2); // no throw, no leak
    expect((await sub.next()).done).toBe(true);
  });
});
