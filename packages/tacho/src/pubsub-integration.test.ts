import { describe, expect, test } from "bun:test";
import { tacho } from "./index";
import { handle } from "./transport/fetch";
import { Publisher } from "./pubsub";

const rpc = tacho();

describe("procedure signal", () => {
  test("run receives a signal aborted when the stream is closed", async () => {
    const events = new Publisher<{ n: number }>();
    let gotSignal: AbortSignal | undefined;
    const app = rpc({
      live: rpc.run(async function* ({ signal }) {
        gotSignal = signal;
        for await (const n of events.subscribe("n", { signal })) yield n;
      }),
    });

    const stream = await app.live();
    const first = stream.next();
    events.publish("n", 1);
    expect((await first).value).toBe(1);
    await stream.return(undefined);
    expect(gotSignal?.aborted).toBe(true);
    // subscriber is gone: publish must not throw and stream stays closed
    events.publish("n", 2);
    expect((await stream.next()).done).toBe(true);
  });

  test("signal works through output validation wrapper", async () => {
    const events = new Publisher<{ n: number }>();
    const app = rpc({
      live: rpc
        .output({
          "~standard": {
            validate: (v: unknown) =>
              typeof v === "number" ? { value: v } : { issues: [{ message: "number" }] },
          },
        })
        .run(async function* ({ signal }) {
          for await (const n of events.subscribe("n", { signal })) yield n;
        }),
    });
    const stream = (await app.live()) as unknown as AsyncGenerator<number>;
    const first = stream.next();
    events.publish("n", 7);
    expect((await first).value).toBe(7);
    await stream.return(undefined);
    events.publish("n", 8);
    expect((await stream.next()).done).toBe(true);
  });

  test("SSE client disconnect unwinds the generator", async () => {
    const events = new Publisher<{ n: number }>();
    let cleaned = false;
    const app = rpc({
      live: rpc.run(async function* ({ signal }) {
        try {
          for await (const n of events.subscribe("n", { signal })) yield n;
        } finally {
          cleaned = true;
        }
      }),
    });
    const server = Bun.serve({
      port: 0,
      fetch: (req) => handle(app)(req),
    });
    const controller = new AbortController();
    const resPromise = fetch(`http://localhost:${server.port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "live", id: 1 }),
      signal: controller.signal,
    });
    // headers only flush after the first frame; publish to unblock the stream
    const publisher = setInterval(() => events.publish("n", 1), 10);
    const res = await resPromise;
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    clearInterval(publisher);
    controller.abort();
    await res.body?.cancel().catch(() => {});
    for (let i = 0; i < 50 && !cleaned; i++) await new Promise((r) => setTimeout(r, 10));
    expect(cleaned).toBe(true);
    server.stop(true);
  });
});
