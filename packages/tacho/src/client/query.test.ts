import { describe, expect, test } from "bun:test";
import { createClient } from "./http";
import { handle } from "../transport/fetch";
import { RpcError, tacho } from "../index";

const schema = <T>(fn: (v: unknown) => { value?: T; issues?: unknown }) => ({
  "~standard": {
    version: 1,
    validate: fn,
  },
});
const rpc = tacho();
let n = 0;
const router = rpc({
  n: rpc.input(schema((v) => ({ value: v }))).run(() => ++n),
  echo: rpc.input(schema((v) => ({ value: v }))).run(({ input }) => input),
  boom: rpc.run(() => {
    throw new RpcError({ code: -32001, message: "nope" });
  }),
});

const client = () =>
  createClient<typeof router>({
    url: "http://x/rpc",
    fetch: ((i: RequestInfo | URL, init?: RequestInit) =>
      handle(router)(new Request(i, init))) as typeof fetch,
  });

describe("query extras", () => {
  test("normal calls bypass the cache", async () => {
    const c = client();
    await c.n({ v: "plain" });
    const before = n;
    await c.n({ v: "plain" });
    expect(n).toBe(before + 1);
  });

  test("same method + same input returns the cached value", async () => {
    const c = client();
    const first = await c.query().n({ v: "dedupe" });
    const second = await c.query().n({ v: "dedupe" });
    expect(first).toBe(second);
  });

  test("different inputs are distinct entries", async () => {
    const c = client();
    const a = await c.query().n({ v: "a" });
    const b = await c.query().n({ v: "b" });
    expect(a).not.toBe(b);
  });

  test("object key order does not matter", async () => {
    const c = client();
    const a = await c.query().echo({ x: 1, y: 2 });
    const b = await c.query().echo({ y: 2, x: 1 });
    expect(b).toEqual(a);
    expect(c.cache.keys()).toHaveLength(1);
  });

  test("staleTime expires and refetches", async () => {
    let calls = 0;
    const rt = rpc({
      now: rpc.run(() => ++calls),
    });
    const c = createClient<typeof rt>({
      url: "http://x/rpc",
      fetch: ((i: RequestInfo | URL, init?: RequestInit) =>
        handle(rt)(new Request(i, init))) as typeof fetch,
    });
    // Deterministic time: freshness checks read Date.now.
    const realNow = Date.now;
    let t = 0;
    Date.now = () => t;
    try {
      const q = c.query({ staleTime: 5 });
      const v1 = await q.now();
      t += 10;
      const v2 = await q.now();
      expect(v2).toBe(v1 + 1);
    } finally {
      Date.now = realNow;
    }
  });
  test("errors are not cached", async () => {
    const c = client();
    let first = false;
    let second = false;
    try {
      await c.query().boom();
    } catch {
      first = true;
    }
    try {
      await c.query().boom();
    } catch {
      second = true;
    }
    expect(first && second).toBe(true); // retried instead of replaying a cached failure
  });

  test("invalidate drops the entry so next call hits the wire", async () => {
    const c = client();
    const v1 = await c.query().n({ v: "inv" });
    await c.cache.invalidate(["n"]);
    const v2 = await c.query().n({ v: "inv" });
    expect(v2).toBe(v1 + 1);
  });

  test("invalidate with refetch re-runs stored params", async () => {
    const c = client();
    const v1 = await c.query().n({ v: "refetch-me" });
    await c.cache.invalidate(["n"], { refetch: true });
    const again = await c.query().n({ v: "refetch-me" });
    expect(again).toBe(v1 + 1); // refetched already before the direct call
  });

  test("clear drops everything", async () => {
    const c = client();
    await c.query().echo("one");
    await c.query().echo("two");
    expect(c.cache.keys().length).toBeGreaterThan(0);
    c.cache.clear();
    expect(c.cache.keys()).toHaveLength(0);
  });

  test("custom key routes under user-supplied identity", async () => {
    const c = client();
    const a = await c.query({ key: ["page", 1] }).echo("anything");
    const b = await c.query({ key: ["page", 1] }).echo("anything");
    expect(a).toBe(b);
    expect(c.cache.keys()[0]).toEqual(["page", 1]);
    await c.cache.invalidate(["page"]);
    expect(c.cache.keys()).toHaveLength(0);
  });
});
