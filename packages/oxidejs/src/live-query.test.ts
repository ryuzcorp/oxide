import { describe, expect, test } from "bun:test";

import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

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

  test("mutateEffect serializes and subscribeStream yields", async () => {
    const q = liveQuery<number>({ topic: `effect-${crypto.randomUUID()}` });

    await Effect.runPromise(
      q
        .mutateEffect(() => Effect.succeed(3))
        .pipe(Effect.andThen(() => q.mutateEffect(() => Effect.succeed(4))))
    );

    const values: number[] = [];
    for await (const n of Stream.toAsyncIterable(
      q.subscribeStream(Effect.void)
    )) {
      values.push(n);
      if (values.length >= 1) {
        break;
      }
    }
    expect(values).toEqual([4]);
  });

  test("a mutation whose predecessor never releases still runs after mutateWaitMs", async () => {
    const q = liveQuery<number>({
      mutateWaitMs: 50,
      topic: `orphan-${crypto.randomUUID()}`,
    });
    // A mutation that never settles, like one whose request the host dropped.
    void q.mutate(() => Effect.runPromise(Effect.never));
    const started = Date.now();
    const value = await q.mutate(() => Promise.resolve(7));
    expect(value).toBe(7);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("close() ends open streams and frees the topic", async () => {
    const topic = `close-${crypto.randomUUID()}`;
    const q = liveQuery<number>({ topic });
    const collected = Effect.runPromise(
      Stream.runCollect(q.stream().pipe(Stream.take(5)))
    );
    q.publish(1);
    await Bun.sleep(5);
    q.close();
    const values = await collected;
    expect([...values].length).toBeLessThanOrEqual(1);
    // A new handle on the same topic gets a fresh hub.
    const again = liveQuery<number>({ topic });
    again.publish(2);
    const iter = again.values()[Symbol.asyncIterator]();
    expect(await iter.next()).toEqual({ done: false, value: 2 });
    await iter.return?.();
  });

  test("a mutation superseded during the bounded wait does not publish its older snapshot", async () => {
    const q = liveQuery<string>({
      mutateWaitMs: 20,
      topic: `order-${crypto.randomUUID()}`,
    });
    const seen: string[] = [];
    const collected = Effect.runPromise(
      Stream.runForEach(q.stream().pipe(Stream.take(1)), (value) =>
        Effect.sync(() => seen.push(value))
      )
    );
    // The older mutation outlives the wait; the newer one runs and publishes first.
    const older = q.mutate(async () => {
      await Bun.sleep(80);
      return "older";
    });
    await q.mutate(() => Promise.resolve("newer"));
    expect(await older).toBe("older");
    await collected;
    expect(seen).toEqual(["newer"]);
    const iter = q.values()[Symbol.asyncIterator]();
    expect(await iter.next()).toEqual({ done: false, value: "newer" });
    await iter.return?.();
  });

  test("a mutation that finishes after close() fails instead of reporting success", async () => {
    const q = liveQuery<number>({ topic: `closed-${crypto.randomUUID()}` });
    const pending = q.mutate(async () => {
      await Bun.sleep(20);
      return 7;
    });
    q.close();
    await expect(pending).rejects.toMatchObject({
      _tag: "LiveQueryClosedError",
    });
  });
});
