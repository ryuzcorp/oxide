import { describe, expect, test } from "bun:test";

import { liveQuery, publish } from "./live-query";

describe("liveQuery", () => {
  test("replays the latest value to a late subscriber", async () => {
    const q = liveQuery<number>({ topic: `replay-${crypto.randomUUID()}` });
    q.publish(1);
    q.publish(2);

    const iter = q.values()[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first).toEqual({ done: false, value: 2 });
    await iter.return?.();
  });

  test("mutate serializes and publishes", async () => {
    const q = liveQuery<number>({ topic: `mutate-${crypto.randomUUID()}` });
    const order: number[] = [];

    const a = q.mutate(async () => {
      await Bun.sleep(20);
      order.push(1);
      return 1;
    });
    const b = q.mutate(() => {
      order.push(2);
      return Promise.resolve(2);
    });

    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(order).toEqual([1, 2]);

    const iter = q.values()[Symbol.asyncIterator]();
    expect(await iter.next()).toEqual({ done: false, value: 2 });
    await iter.return?.();
  });

  test("subscribe seed then yields published values", async () => {
    const topic = `sub-${crypto.randomUUID()}`;
    const q = liveQuery<string>({ topic });
    const gen = q.subscribe(() => {
      q.publish("seed");
      return Promise.resolve();
    })();

    const first = await gen.next();
    expect(first).toEqual({ done: false, value: "seed" });

    q.publish("next");
    const second = await gen.next();
    expect(second).toEqual({ done: false, value: "next" });
    await gen.return?.();
  });

  test("publish(topic) reaches liveQuery subscribers", async () => {
    const topic = `pub-${crypto.randomUUID()}`;
    const q = liveQuery<{ n: number }>({ topic });
    publish(topic, { n: 7 });

    const iter = q.values()[Symbol.asyncIterator]();
    expect(await iter.next()).toEqual({ done: false, value: { n: 7 } });
    await iter.return?.();
  });
});
