/* eslint-disable func-names -- Effect.gen uses anonymous generators (AGENTS.md) */
import { expect, test } from "bun:test";

import { Effect, Layer, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { getRequestStore } from "../context";
import { isWebcontainerVersions } from "../request-store";
import { createActionHandler } from "./server";

interface Probe {
  builds: number;
  finalized: number;
  interrupted: number;
}

const makeProbe = (): Probe => ({ builds: 0, finalized: 0, interrupted: 0 });

const makeGroup = () =>
  RpcGroup.make(
    Rpc.make("ping", { success: Schema.String }),
    Rpc.make("slow", { success: Schema.String }),
    Rpc.make("whoami", { success: Schema.String })
  );

/** Handlers whose layer counts builds and teardowns. `slow` outlives any test deadline. */
const makeHandlers = function makeHandlers(
  group: ReturnType<typeof makeGroup>,
  probe: Probe,
  slowFor: `${number} millis` = "10000 millis"
) {
  const handlers = group.toLayer({
    ping: () => Effect.succeed("pong"),
    slow: () =>
      Effect.sleep(slowFor).pipe(
        Effect.as("late"),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            probe.interrupted += 1;
          })
        )
      ),
    // Reads the request store the way generated handlers do, then yields so
    // concurrent calls interleave.
    whoami: () => {
      const store = getRequestStore();
      return Effect.promise(async () => {
        await Bun.sleep(Math.random() * 10);
        return store.req.headers.get("x-user") ?? "none";
      });
    },
  });
  const counted = Layer.effectDiscard(
    Effect.gen(function* () {
      probe.builds += 1;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          probe.finalized += 1;
        })
      );
    })
  );
  return Layer.merge(handlers, counted);
};

const post = function post(body: string, headers: HeadersInit = {}) {
  return new Request("http://localhost/__oxide/action", {
    body,
    headers,
    method: "POST",
  });
};

const call = (method: string, id: number) =>
  JSON.stringify({ id, jsonrpc: "2.0", method });

interface Frame {
  error?: { code: number; message: string };
  id: number | null;
  result?: string;
}

const frames = (text: string): Frame[] =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      // SAFETY: the action endpoint answers JSON-RPC frames, one per line.
      const frame = JSON.parse(line) as Frame;
      return frame;
    });

const handlerFor = function handlerFor(
  probe: Probe,
  options: Parameters<typeof createActionHandler>[2] = {},
  slowFor?: `${number} millis`
) {
  const group = makeGroup();
  // SAFETY: the test group and layer are the shapes the generated actions module passes.
  return createActionHandler(
    group as never,
    makeHandlers(group, probe, slowFor) as never,
    { sameOrigin: false, ...options }
  );
};

test("every request builds its own action runtime and disposes it after the body", async () => {
  const probe = makeProbe();
  const handle = handlerFor(probe);
  const responses = await Promise.all(
    [1, 2, 3].map((id) => handle(post(call("ping", id))))
  );
  const bodies = await Promise.all(responses.map((res) => res.text()));
  expect(bodies.map((body) => frames(body)[0]?.result)).toEqual([
    "pong",
    "pong",
    "pong",
  ]);
  expect(probe.builds).toBe(3);
  expect(probe.finalized).toBe(3);
});

test("concurrent requests each see only their own request context", async () => {
  const handle = handlerFor(makeProbe());
  const users = Array.from({ length: 30 }, (_, i) => `user${i}`);
  const seen = await Promise.all(
    users.map(async (user) => {
      const res = await handle(post(call("whoami", 1), { "x-user": user }));
      return frames(await res.text())[0]?.result;
    })
  );
  expect(seen).toEqual(users);
});

test("an action past timeoutMs answers with a JSON-RPC error and is interrupted", async () => {
  const probe = makeProbe();
  const handle = handlerFor(probe, { timeoutMs: 50 });
  const started = Date.now();
  const res = await handle(post(call("slow", 7)));
  expect(Date.now() - started).toBeLessThan(1000);
  const expected: Frame & { jsonrpc: string } = {
    error: { code: -32_603, message: "Action timed out after 50ms" },
    id: 7,
    jsonrpc: "2.0",
  };
  expect(frames(await res.text())).toEqual([expected]);
  await Bun.sleep(20);
  expect(probe.interrupted).toBe(1);
  expect(probe.finalized).toBe(1);
});

test("a batch times out per call and keeps the calls that answered", async () => {
  const probe = makeProbe();
  const handle = handlerFor(probe, { timeoutMs: 50 });
  const res = await handle(post(`[${call("ping", 1)},${call("slow", 2)}]`));
  const byId = new Map(frames(await res.text()).map((f) => [f.id, f]));
  expect(byId.get(1)?.result).toBe("pong");
  expect(byId.get(2)?.error?.message).toBe("Action timed out after 50ms");
});

test("a batch streams each result as soon as its call ends", async () => {
  const handle = handlerFor(makeProbe(), {}, "300 millis");
  const started = Date.now();
  const res = await handle(post(`[${call("slow", 1)},${call("ping", 2)}]`));
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("expected a streamed body");
  }
  const decoder = new TextDecoder();
  const first = await reader.read();
  const firstAt = Date.now() - started;
  let text = decoder.decode(first.value);
  expect(frames(text)[0]).toMatchObject({ id: 2, result: "pong" });
  expect(firstAt).toBeLessThan(200);
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- ordered stream reads
    const next = await reader.read();
    if (next.done) {
      break;
    }
    text += decoder.decode(next.value);
  }
  expect(frames(text).map((f) => f.id)).toEqual([2, 1]);
});

test("cancelling a batch body mid-stream does not break the remaining calls", async () => {
  const handle = handlerFor(makeProbe(), {}, "100 millis");
  const res = await handle(
    post(`[${call("ping", 1)},${call("slow", 2)},${call("slow", 3)}]`)
  );
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("expected a streamed body");
  }
  await reader.read();
  await reader.cancel();
  // The slow calls finish after the cancel; their results must be dropped
  // quietly, and the handler keeps serving.
  await Bun.sleep(200);
  const after = await handle(post(call("ping", 4)));
  expect(frames(await after.text())[0]?.result).toBe("pong");
});

test("a body over maxBodyBytes is refused with 413 before any action runs", async () => {
  const probe = makeProbe();
  const handle = handlerFor(probe, { maxBodyBytes: 16 });
  const res = await handle(post(call("ping", 1)));
  expect(res.status).toBe(413);
  expect(probe.builds).toBe(0);
});

test("a stub-function versions key (celld's node:process) is not a WebContainer", () => {
  // celld's node:process answers every unknown versions key with a stub function.
  const celldVersions = { webcontainer: () => null };
  expect(isWebcontainerVersions(celldVersions)).toBe(false);
  expect(isWebcontainerVersions({ webcontainer: "1.0.0" })).toBe(true);
  expect(isWebcontainerVersions({ node: "22.0.0" })).toBe(false);
});
