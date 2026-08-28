import { describe, expect, test } from "bun:test";
import { createClient } from "./http";
import { handle } from "../transport/fetch";
import { createCache, RpcError, query as tachoQuery, tacho, type CacheDriver } from "../index";

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
    expect(c.cache.keys()[0]?.slice(0, 2)).toEqual(["page", 1]);
    await c.cache.invalidate(["page"]);
    expect(c.cache.keys()).toHaveLength(0);
  });

  test("query() wraps any async fn with per-input caching", async () => {
    let calls = 0;
    const fetchUser = async ({ id }: { id: string }) => ({ id, n: ++calls });
    const getQ = tachoQuery(fetchUser);
    const a = await getQ({ id: "u1" });
    const b = await getQ({ id: "u1" });
    const c = await getQ({ id: "u2" });
    expect(a).toBe(b); // same input: one call
    expect(c).not.toBe(a);
    await getQ.invalidate();
    const d = await getQ({ id: "u1" });
    expect(d.n).toBe(a.n + 2);
  });

  test("query() predicates filter invalidation by args", async () => {
    let calls = 0;
    const inc = async (_id?: string) => ++calls;
    const q = tachoQuery(inc);
    await q("a");
    const vB = await q("b");
    q.invalidate(({ args }) => args[0] === "a");
    expect(await q("a")).toBe(vB + 1); // dropped -> fresh call on next invoke
    expect(await q("b")).toBe(vB); // untouched
  });

  test("query() failures are never cached", async () => {
    let tries = 0;
    const flaky = async () => {
      if (++tries < 3) throw new Error(`nope ${tries}`);
      return "ok";
    };
    const q = tachoQuery(flaky);
    try {
      await q();
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toBe("nope 1");
    }
    try {
      await q();
      throw new Error("should have thrown again");
    } catch (e) {
      expect((e as Error).message).toBe("nope 2"); // retried, not replayed from cache
    }
    expect(await q()).toBe("ok");
  });
  test("createCache persists through the driver and hydrates a second handle", async () => {
    const backing = new Map<string, string>();
    const driver: CacheDriver = {
      keys: () => [...backing.keys()],
      get: (k) => backing.get(k),
      set: (k, v) => void backing.set(k, v),
      delete: (k) => void backing.delete(k),
    };
    let calls = 0;
    const fetchUser = async ({ id }: { id: string }) => ({ id, n: ++calls });

    const first = createCache({ name: "app", driver });
    const q1 = tachoQuery(fetchUser, { cache: first, key: ["users"] });
    const v = await q1({ id: "u1" });
    expect(backing.size).toBeGreaterThan(0); // written through

    // A fresh handle over the same storage sees the persisted result.
    const second = createCache({ name: "app", driver });
    const q2 = tachoQuery(fetchUser, { cache: second, key: ["users"] });
    const hydrated = await q2({ id: "u1" });
    expect(hydrated).toEqual(v);
    expect(calls).toBe(1); // no re-run
  });

  test("handle invalidation deletes driver entries and hits all consumers", async () => {
    const backing = new Map<string, string>();
    const driver: CacheDriver = {
      keys: () => [...backing.keys()],
      get: (k) => backing.get(k),
      set: (k, v) => void backing.set(k, v),
      delete: (k) => void backing.delete(k),
    };
    let calls = 0;
    const fetchUser = async ({ id }: { id: string }) => ({ id, n: ++calls });
    const cache = createCache({ name: "app", driver });
    const q = tachoQuery(fetchUser, { cache, key: ["users"] });
    await q({ id: "u1" });
    expect(backing.size).toBe(1);
    await cache.invalidate(["users"]);
    expect(backing.size).toBe(0);
    expect((await q({ id: "u1" })).n).toBe(2);
  });

  test("stale persisted entries are ignored on hydration", async () => {
    const backing = new Map<string, string>();
    const driver: CacheDriver = {
      keys: () => [...backing.keys()],
      get: (k) => backing.get(k),
      set: (k, v) => void backing.set(k, v),
      delete: (k) => void backing.delete(k),
    };
    let calls = 0;
    const now = async () => ++calls;
    const first = createCache({ name: "app", driver });
    const q1 = tachoQuery(now, { cache: first, key: ["t"], staleTime: 10 });
    await q1();
    // Freeze hydration at a later clock so the stored window has expired.
    const realNow = Date.now;
    Date.now = () => realNow() + 100;
    try {
      const second = createCache({ name: "app", driver });
      const q2 = tachoQuery(now, { cache: second, key: ["t"], staleTime: 10 });
      const v = await q2();
      expect(calls).toBe(2); // hydrated as stale -> refetched
      expect(v).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });
});
