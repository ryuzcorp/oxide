import { describe, expect, test } from "bun:test";
import {
  APP_ERROR_RANGE,
  tacho,
  JSON_RPC_ERROR,
  router,
  RpcError,
  runOne,
  runBatch,
  rpcResult,
  resolveProcedure,
  toOpenRpc,
  type RPCClient,
} from "./index";
import { createClient } from "./client/http";
import { createClient as createWsClient } from "./client/ws";
import { fileHeaders, injectFiles, safeFileName } from "./file";
import { handle } from "./transport/fetch";
import { handle as handleWs } from "./transport/ws";

const schema = <T>(
  fn: (v: unknown) => { value?: T; issues?: unknown } | Promise<{ value?: T; issues?: unknown }>,
) => ({ "~standard": { validate: fn } });

const idSchema = schema((v) =>
  v && typeof v === "object" && typeof (v as any).id === "string"
    ? { value: v as { id: string } }
    : { issues: [{ message: "expected {id:string}" }] },
);

const nameSchema = schema((v) =>
  v && typeof v === "object" && typeof (v as any).name === "string"
    ? { value: v as { name: string } }
    : { issues: [{ message: "expected {name:string}" }] },
);

const rpc = tacho<{ user?: string }>();
const app = rpc({
  ping: rpc.run(() => "pong" as const),
  boom: rpc.run(() => {
    throw new Error("kaboom");
  }),
  appErr: rpc.run(() => {
    throw new RpcError({ code: -32001, message: "nope", data: { x: 1 } });
  }),
  user: {
    get: rpc.input(idSchema).run(({ input }) => ({ id: input.id, name: "Ada" })),
    posts: { list: rpc.run(() => [{ id: 1 }]) },
  },
  greet: rpc.use(async ({ next }) => next({ ctx: { user: "ada" } })).run(({ ctx }) => ctx.user),
});

const fetchHandler = handle(app);
const call = (body: unknown, init?: RequestInit & { url?: string }) =>
  fetchHandler(
    new Request(init?.url ?? "http://x/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    }),
  );

describe("spec matrix", () => {
  test("1 valid single request", async () => {
    const res = await call({ jsonrpc: "2.0", method: "ping", id: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", result: "pong", id: 1 });
  });

  test("2 id: null is a request, echoed", async () => {
    expect(await (await call({ jsonrpc: "2.0", method: "ping", id: null })).json()).toEqual({
      jsonrpc: "2.0",
      result: "pong",
      id: null,
    });
  });

  test("3 no id key is notification → 204", async () => {
    const res = await call({ jsonrpc: "2.0", method: "ping" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  test("4 unknown method", async () => {
    expect(await (await call({ jsonrpc: "2.0", method: "nope", id: 1 })).json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32601, message: "Method not found" },
      id: 1,
    });
  });

  test("5 malformed JSON", async () => {
    const res = await call("{", {
      headers: { "content-type": "application/json" },
    });
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
      id: null,
    });
  });

  test("6 missing jsonrpc", async () => {
    expect(await (await call({ method: "ping", id: 1 })).json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid Request" },
      id: 1,
    });
  });

  test("7 params fail schema", async () => {
    const body = await (
      await call({ jsonrpc: "2.0", method: "user.get", params: {}, id: 1 })
    ).json();
    expect(body.error.code).toBe(-32602);
    expect(body.error.data).toBeDefined();
    expect(body).not.toHaveProperty("result");
  });

  test("8 plain Error → INTERNAL_ERROR, no message leak, no stack", async () => {
    const body = await (await call({ jsonrpc: "2.0", method: "boom", id: 1 })).json();
    expect(body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error" },
      id: 1,
    });
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  test("9 RpcError passed through", async () => {
    expect(await (await call({ jsonrpc: "2.0", method: "appErr", id: 1 })).json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32001, message: "nope", data: { x: 1 } },
      id: 1,
    });
  });

  test("10 empty batch is single error object", async () => {
    const res = await call([]);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(false);
    expect(body).toEqual({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Invalid Request" },
      id: null,
    });
  });

  test("11 batch 3 valid + 1 notification", async () => {
    const body = await (
      await call([
        { jsonrpc: "2.0", method: "ping", id: 1 },
        { jsonrpc: "2.0", method: "ping" },
        { jsonrpc: "2.0", method: "ping", id: 2 },
        { jsonrpc: "2.0", method: "user.get", params: { id: "a" }, id: 3 },
      ])
    ).json();
    expect(body).toEqual([
      { jsonrpc: "2.0", result: "pong", id: 1 },
      { jsonrpc: "2.0", result: "pong", id: 2 },
      { jsonrpc: "2.0", result: { id: "a", name: "Ada" }, id: 3 },
    ]);
  });

  test("12 batch of only notifications → 204", async () => {
    const res = await call([
      { jsonrpc: "2.0", method: "ping" },
      { jsonrpc: "2.0", method: "boom" },
    ]);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  test("13 nested user.posts.list", async () => {
    expect(await (await call({ jsonrpc: "2.0", method: "user.posts.list", id: 1 })).json()).toEqual(
      { jsonrpc: "2.0", result: [{ id: 1 }], id: 1 },
    );
  });

  test("14 rpc.internal reserved", async () => {
    expect(await (await call({ jsonrpc: "2.0", method: "rpc.internal", id: 1 })).json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32601, message: "Method not found" },
      id: 1,
    });
  });

  test("15 middleware mutates context", async () => {
    expect(await (await call({ jsonrpc: "2.0", method: "greet", id: 1 })).json()).toEqual({
      jsonrpc: "2.0",
      result: "ada",
      id: 1,
    });
  });

  test("16a rejects unsupported content-type", async () => {
    const res = await fetchHandler(
      new Request("http://x/rpc", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      }),
    );
    expect(res.status).toBe(415);
    expect((await res.json()).error.message).toBe("Unsupported Content-Type");
  });

  test("16b rejects oversized batch", async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      jsonrpc: "2.0",
      method: "ping",
      id: i,
    }));
    const res = await call(items);
    expect((await res.json()).error.message).toBe("Batch too large");
  });

  test("16c rejects oversized body", async () => {
    const small = handle(app, { maxBodySize: 16 });
    const res = await small(
      new Request("http://x/rpc", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "999999",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      }),
    );
    expect(res.status).toBe(413);
  });

  test("16 client proxy round-trip", async () => {
    const client = createClient<typeof app>({
      url: "http://x/rpc",
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        fetchHandler(new Request(input, init))) as typeof fetch,
    });
    expect(await client.ping()).toBe("pong");
    expect(await client.user.get({ id: "1" })).toEqual({
      id: "1",
      name: "Ada",
    });
    const _typed: RPCClient<typeof app> = client;
    expect(_typed).toBe(client);
  });

  test("17 custom serializer round-trip", async () => {
    const customSerializer = {
      stringify: (val: any) => "CUSTOM::" + JSON.stringify(val),
      parse: (val: string) => JSON.parse(val.replace(/^CUSTOM::/, "")),
      contentType: "application/custom-json",
    };
    const customApp = tacho()({ ping: tacho().run(() => "pong") });
    const customHandle = handle(customApp, { serializer: customSerializer });
    const client = createClient<typeof customApp>({
      url: "http://x/rpc",
      serializer: customSerializer,
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.headers).toMatchObject({ "content-type": "application/custom-json" });
        expect(init?.body).toMatch(/^CUSTOM::/);
        return customHandle(new Request("http://x/rpc", init));
      }) as typeof fetch,
    });
    expect(await client.ping()).toBe("pong");
  });

  test("18 non-POST → 405 Allow: POST", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const res = await fetchHandler(new Request("http://x/rpc", { method }));
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
    }
  });

  test("18 OPTIONS and HEAD are not POST", async () => {
    for (const method of ["OPTIONS", "HEAD"]) {
      const res = await fetchHandler(new Request("http://x/rpc", { method }));
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
    }
  });
});

test("id type preserved (string vs number)", async () => {
  expect((await (await call({ jsonrpc: "2.0", method: "ping", id: "abc" })).json()).id).toBe("abc");
  expect((await (await call({ jsonrpc: "2.0", method: "ping", id: 42 })).json()).id).toBe(42);
});

test("notification errors are silent", async () => {
  expect((await call({ jsonrpc: "2.0", method: "nope" })).status).toBe(204);
  expect((await call({ jsonrpc: "2.0", method: "boom" })).status).toBe(204);
});

test("path option 404s other paths", async () => {
  const h = handle(app, { path: "/rpc" });
  expect(
    (
      await h(
        new Request("http://x/other", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await h(
        new Request("http://x/rpc/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await h(
        new Request("http://x/rpc%2f", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await h(
        new Request("http://x/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
        }),
      )
    ).status,
  ).toBe(200);
});

test("createContext + client headers", async () => {
  const whoApp = router({
    who: tacho<{ who: string }>().run(({ ctx }) => ctx.who),
  });
  const h = handle(whoApp, {
    createContext: (req) => ({ who: req.headers.get("x-who") ?? "" }),
  });
  const client = createClient<typeof whoApp>({
    url: "http://x/",
    headers: { "x-who": "ada" },
    fetch: ((i: RequestInfo | URL, init?: RequestInit) => h(new Request(i, init))) as typeof fetch,
  });
  expect(await client.who()).toBe("ada");
});

test("client throws on rpc error and transport failure", async () => {
  const client = createClient<typeof app>({
    url: "http://x/rpc",
    fetch: ((i: RequestInfo | URL, init?: RequestInit) =>
      fetchHandler(new Request(i, init))) as typeof fetch,
  });
  try {
    await client.boom();
    throw new Error("expected");
  } catch (err: any) {
    expect(err).toBeInstanceOf(RpcError);
    expect(err.message).toBe("Internal error");
    expect(err.code).toBe(-32603);
  }
  const dead = createClient<typeof app>({
    url: "http://x/",
    fetch: (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch,
  });
  await expect(dead.ping()).rejects.toThrow(/502/);
});

test("exports", () => {
  expect(JSON_RPC_ERROR.PARSE_ERROR).toBe(-32700);
  expect(APP_ERROR_RANGE).toEqual({ min: -32099, max: -32000 });
  expect(nameSchema["~standard"]).toBeDefined();
});

describe("websocket", () => {
  const hooks = handleWs(app);
  const callWs = async (raw: unknown | string) => {
    const sent: unknown[] = [];
    await hooks.message(
      { context: {}, send: (data) => sent.push(data) },
      {
        text: () => (typeof raw === "string" ? raw : JSON.stringify(raw)),
        json: () => (typeof raw === "string" ? JSON.parse(raw) : raw),
      },
    );
    return sent.map((s) => (typeof s === "string" ? JSON.parse(s) : s));
  };

  test("upgrade rejects other paths and cross-origin requests", () => {
    const gated = handleWs(app, { path: "/rpc", sameOrigin: true });
    const denied = gated.upgrade(new Request("http://x/other"));
    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(404);
    expect(
      gated.upgrade(new Request("http://x/rpc", { headers: { origin: "http://evil.com" } })),
    ).toMatchObject({ status: 403 });
    expect(
      gated.upgrade(new Request("http://x/rpc", { headers: { origin: "http://x" } })),
    ).toBeUndefined();
  });

  test("rejects oversized messages before parsing", async () => {
    const limited = handleWs(app, { maxMessageSize: 8 });
    const sent: string[] = [];
    await limited.message(
      { context: {}, send: (data) => sent.push(String(data)) },
      { text: () => JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }) },
    );
    expect(JSON.parse(sent[0]!).error).toMatchObject({
      code: JSON_RPC_ERROR.INVALID_REQUEST,
      message: "Payload too large",
    });
  });

  test("request, notification, parse error", async () => {
    expect(await callWs({ jsonrpc: "2.0", method: "ping", id: 1 })).toEqual([
      { jsonrpc: "2.0", result: "pong", id: 1 },
    ]);
    expect(await callWs({ jsonrpc: "2.0", method: "ping" })).toEqual([]);
    const broken = handleWs(app);
    const sent: unknown[] = [];
    await broken.message(
      { context: {}, send: (data) => sent.push(data) },
      {
        text: () => "{",
        json: () => {
          throw new SyntaxError("bad");
        },
      },
    );
    expect(sent.map((s) => (typeof s === "string" ? JSON.parse(s) : s))).toEqual([
      {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      },
    ]);
  });

  test("client proxy over a mock socket", async () => {
    const hooks = handleWs(app);
    const listeners = new Map<string, Set<(ev: { data?: unknown }) => void>>();
    const emit = (type: string, ev: { data?: unknown } = {}) => {
      for (const fn of listeners.get(type) ?? []) fn(ev);
    };
    class MockSocket {
      readyState = 0;
      addEventListener(type: string, fn: (ev: { data?: unknown }) => void) {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
      }
      send(data: string) {
        const sent: unknown[] = [];
        void hooks
          .message(
            { context: {}, send: (body) => sent.push(body) },
            { text: () => data, json: () => JSON.parse(data) },
          )
          .then(() => {
            for (const body of sent) emit("message", { data: body });
          });
      }
      close() {
        emit("close");
      }
    }
    const socket = new MockSocket();
    const client = createWsClient<typeof app>({
      url: "ws://x",
      WebSocket: function MockWebSocket() {
        queueMicrotask(() => {
          socket.readyState = 1;
          emit("open");
        });
        return socket;
      } as unknown as typeof WebSocket,
    });
    await client.ready;
    expect(await client.ping()).toBe("pong");
    await expect(client.boom()).rejects.toMatchObject({
      message: "Internal error",
      code: -32603,
    });
    client.close();
  });
});

describe("dispatch", () => {
  test("rpc() is router()", () => {
    const ping = rpc.run(() => "pong" as const);
    expect(rpc({ ping }).ping).toBe(ping);
    expect(router({ ping }).ping).toBe(ping);
  });

  test("router is callable locally", async () => {
    expect(await app.ping()).toBe("pong");
    expect(await app.user.get({ id: "1" })).toEqual({ id: "1", name: "Ada" });
    expect(await app.user.posts.list()).toEqual([{ id: 1 }]);
    expect(await app.greet()).toBe("ada");
    await expect(app.user.get({} as { id: string })).rejects.toMatchObject({
      message: "Invalid params",
      code: -32602,
    });
    await expect(app.boom()).rejects.toThrow("kaboom");
    expect(await app.appErr().catch((err: RpcError) => err)).toMatchObject({
      message: "nope",
      code: -32001,
      data: { x: 1 },
    });
  });

  test("resolveProcedure skips empty, reserved, and intermediate nodes", () => {
    expect(resolveProcedure(app, "")).toBeUndefined();
    expect(resolveProcedure(app, "rpc.")).toBeUndefined();
    expect(resolveProcedure(app, "user")).toBeUndefined();
    expect(resolveProcedure(app, "user.missing")).toBeUndefined();
    expect(resolveProcedure(app, "ping")?.__rpc).toBe(true);
  });

  test("resolveProcedure ignores prototype and constructor walks", () => {
    expect(resolveProcedure(app, "__proto__")).toBeUndefined();
    expect(resolveProcedure(app, "constructor")).toBeUndefined();
    expect(resolveProcedure(app, "toString")).toBeUndefined();
    expect(resolveProcedure(app, "user.__proto__.ping")).toBeUndefined();
    expect(resolveProcedure(app, "rpc.discover")).toBeUndefined();
  });

  test("output schema parses the result", async () => {
    const str = schema((v) =>
      typeof v === "string" ? { value: v } : { issues: [{ message: "str" }] },
    );
    const app = rpc({
      ok: rpc.output(str).run(() => "pong"),
      bad: rpc.output(str).run(() => 1 as unknown as string),
    });
    expect(await app.ok()).toBe("pong");
    await expect(app.bad()).rejects.toMatchObject({
      message: "Invalid result",
      code: -32603,
    });
    expect(await runOne(app, { jsonrpc: "2.0", method: "ok", id: 1 }, {})).toEqual({
      jsonrpc: "2.0",
      result: "pong",
      id: 1,
    });
    expect(await runOne(app, { jsonrpc: "2.0", method: "bad", id: 2 }, {})).toMatchObject({
      error: { code: -32603, message: "Invalid result" },
    });
    // @ts-expect-error output must match schema
    rpc.output(str).run(() => 1);
  });

  test("undefined result becomes null", async () => {
    const silent = rpc({ nada: rpc.run(() => undefined) });
    expect(await runOne(silent, { jsonrpc: "2.0", method: "nada", id: 1 }, {})).toEqual({
      jsonrpc: "2.0",
      result: null,
      id: 1,
    });
  });

  test("non-Error throw becomes Internal error", async () => {
    const app = rpc({
      die: rpc.run(() => {
        throw "nope";
      }),
    });
    expect(await runOne(app, { jsonrpc: "2.0", method: "die", id: 1 }, {})).toEqual({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error" },
      id: 1,
    });
  });

  test("async schema + stacked middleware", async () => {
    const seen: string[] = [];
    const app = rpc({
      echo: rpc
        .use(async ({ ctx, next }) => {
          seen.push("a");
          return next({ ctx: { user: `${ctx.user ?? ""}a` } });
        })
        .use(async ({ ctx, next }) => {
          seen.push("b");
          return next({ ctx: { user: `${ctx.user}b` } });
        })
        .input(
          schema(async (v) =>
            typeof v === "string" ? { value: v.toUpperCase() } : { issues: [{ message: "str" }] },
          ),
        )
        .run(({ input, ctx }) => `${input}:${ctx.user}`),
    });
    expect(
      await runOne(app, { jsonrpc: "2.0", method: "echo", params: "hi", id: 1 }, { user: "" }),
    ).toEqual({ jsonrpc: "2.0", result: "HI:ab", id: 1 });
    expect(seen).toEqual(["a", "b"]);
    const bad = await runOne(app, { jsonrpc: "2.0", method: "echo", params: 1, id: 2 }, {});
    expect(bad).toMatchObject({ error: { code: -32602 } });
  });

  test("runBatch returns undefined for all-notifications", async () => {
    expect(await runBatch(app, [{ jsonrpc: "2.0", method: "ping" }], {})).toBeUndefined();
  });

  test("middleware can wrap and skip", async () => {
    const app = rpc({
      wrap: rpc.use(async ({ next }) => `wrapped:${await next()}`).run(() => "ok"),
      skip: rpc.use(async () => "skipped").run(() => "handler"),
    });
    expect(await runOne(app, { jsonrpc: "2.0", method: "wrap", id: 1 }, {})).toEqual({
      jsonrpc: "2.0",
      result: "wrapped:ok",
      id: 1,
    });
    expect(await runOne(app, { jsonrpc: "2.0", method: "skip", id: 2 }, {})).toEqual({
      jsonrpc: "2.0",
      result: "skipped",
      id: 2,
    });
  });
});

describe("rpcResult", () => {
  test("returns result and attaches error fields", () => {
    expect(rpcResult({ result: 1 })).toBe(1);
    try {
      rpcResult({ error: { message: "nope", code: -32001, data: { x: 1 } } });
      throw new Error("expected");
    } catch (err: any) {
      expect(err).toBeInstanceOf(RpcError);
      expect(err).toMatchObject({ message: "nope", code: -32001, data: { x: 1 } });
    }
  });
});

describe("http client", () => {
  test("headers function is awaited", async () => {
    let seen: HeadersInit | undefined;
    const client = createClient<typeof app>({
      url: "http://x/rpc",
      headers: async () => ({ "x-who": "ada" }),
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        seen = init?.headers as HeadersInit;
        return fetchHandler(new Request("http://x/rpc", init));
      }) as typeof fetch,
    });
    expect(await client.ping()).toBe("pong");
    expect(seen).toMatchObject({ "content-type": "application/json", "x-who": "ada" });
  });

  test("signal is forwarded", async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const client = createClient<typeof app>({
      url: "http://x/rpc",
      signal: ac.signal,
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        expect(seen?.aborted).toBe(false);
        ac.abort();
        expect(seen?.aborted).toBe(true);
        return fetchHandler(
          new Request("http://x/rpc", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: init?.body ?? null,
          }),
        );
      }) as typeof fetch,
    });
    await client.ping();
    expect(seen).toBeDefined();
  });

  test("per-call signal is forwarded", async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const client = createClient<typeof app>({
      url: "http://x/rpc",
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        expect(seen?.aborted).toBe(false);
        ac.abort();
        expect(seen?.aborted).toBe(true);
        return fetchHandler(
          new Request("http://x/rpc", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: init?.body ?? null,
          }),
        );
      }) as typeof fetch,
    });
    await client.ping(undefined, { signal: ac.signal });
    expect(seen).toBeDefined();
  });
});

describe("fetch transport", () => {
  test("bad multipart is a parse error, not a 500", async () => {
    const form = new FormData();
    form.set("rpc", "{");
    const res = await fetchHandler(new Request("http://x/rpc", { method: "POST", body: form }));
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
      id: null,
    });
  });

  test("createContext throw is a JSON-RPC error", async () => {
    const seen: unknown[] = [];
    const h = handle(app, {
      createContext: () => {
        throw new Error("ctx boom");
      },
      onError: (err) => seen.push(err),
    });
    const res = await h(
      new Request("http://x/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: { code: -32603, message: "Internal error" },
      id: null,
    });
    expect(seen[0]).toBeInstanceOf(Error);
  });

  test("req is on context by default", async () => {
    const who = tacho<{ req: Request }>();
    const whoApp = who({
      path: who.run(({ ctx }) => new URL(ctx.req.url).pathname),
    });
    const res = await handle(whoApp)(
      new Request("http://x/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "path", id: 1 }),
      }),
    );
    expect(await res.json()).toEqual({ jsonrpc: "2.0", result: "/rpc", id: 1 });
  });
});

describe("ws transport extras", () => {
  test("parses text when json() is missing", async () => {
    const hooks = handleWs(app);
    const sent: unknown[] = [];
    await hooks.message(
      { context: {}, send: (data) => sent.push(data) },
      { text: () => JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }) },
    );
    expect(sent.map((s) => (typeof s === "string" ? JSON.parse(s) : s))).toEqual([
      { jsonrpc: "2.0", result: "pong", id: 1 },
    ]);
  });

  test("createContext + batch", async () => {
    const who = tacho<{ who: string }>();
    const whoApp = who({ who: who.run(({ ctx }) => ctx.who) });
    const hooks = handleWs(whoApp, {
      createContext: (peer) => ({ who: String(peer.context["who"] ?? "") }),
    });
    const sent: unknown[] = [];
    await hooks.message(
      { context: { who: "ada" }, send: (data) => sent.push(data) },
      {
        text: () =>
          JSON.stringify([
            { jsonrpc: "2.0", method: "who", id: 1 },
            { jsonrpc: "2.0", method: "who" },
          ]),
      },
    );
    expect(sent.map((s) => (typeof s === "string" ? JSON.parse(s) : s))).toEqual([
      [{ jsonrpc: "2.0", result: "ada", id: 1 }],
    ]);

    const seen: unknown[] = [];
    const boom = handleWs(app, {
      createContext: () => {
        throw new Error("ws ctx");
      },
      onError: (err) => seen.push(err),
    });
    const failed: unknown[] = [];
    await boom.message(
      { context: {}, send: (data) => failed.push(data) },
      { text: () => JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }) },
    );
    expect(failed.map((s) => (typeof s === "string" ? JSON.parse(s) : s))[0]).toMatchObject({
      error: { code: -32603 },
    });
    expect(seen[0]).toBeInstanceOf(Error);
  });
});

describe("ws client extras", () => {
  const listeners = () => {
    const map = new Map<string, Set<(ev: { data?: unknown }) => void>>();
    const emit = (type: string, ev: { data?: unknown } = {}) => {
      for (const fn of map.get(type) ?? []) fn(ev);
    };
    return {
      emit,
      listen(type: string, fn: (ev: { data?: unknown }) => void) {
        const set = map.get(type) ?? new Set();
        set.add(fn);
        map.set(type, set);
      },
    };
  };

  test("rejects on socket error, close, and ignores junk", async () => {
    const { emit, listen } = listeners();
    const client = createWsClient<typeof app>({
      url: "ws://x",
      WebSocket: function MockWebSocket() {
        return {
          addEventListener: listen,
          send() {},
          close() {
            emit("close");
          },
        };
      } as unknown as typeof WebSocket,
    });
    queueMicrotask(() => emit("error"));
    await expect(client.ready).rejects.toThrow("RPC transport error");

    const live = listeners();
    let opened = false;
    const liveClient = createWsClient<typeof app>({
      url: "ws://x",
      WebSocket: function MockWebSocket() {
        return {
          addEventListener: live.listen,
          send() {
            opened = true;
          },
          close() {
            live.emit("close");
          },
        };
      } as unknown as typeof WebSocket,
    });
    queueMicrotask(() => live.emit("open"));
    await liveClient.ready;
    const pending = liveClient.ping();
    await Promise.resolve();
    expect(opened).toBe(true);
    live.emit("message", { data: "not-json" });
    live.emit("message", { data: { id: null, result: 1 } });
    live.emit("message", { data: [{ id: 99, result: "ghost" }] });
    live.emit("close");
    await expect(pending).rejects.toThrow("socket closed");
  });

  test("close before open rejects ready", async () => {
    const { emit, listen } = listeners();
    const client = createWsClient<typeof app>({
      url: "ws://x",
      WebSocket: function MockWebSocket() {
        return { addEventListener: listen, send() {}, close() {} };
      } as unknown as typeof WebSocket,
    });
    queueMicrotask(() => emit("close"));
    await expect(client.ready).rejects.toThrow("socket closed");
  });

  test("per-call signal stops waiting", async () => {
    const { emit, listen } = listeners();
    const client = createWsClient<typeof app>({
      url: "ws://x",
      WebSocket: function MockWebSocket() {
        return { addEventListener: listen, send() {}, close() {} };
      } as unknown as typeof WebSocket,
    });
    queueMicrotask(() => emit("open"));
    await client.ready;

    const ac = new AbortController();
    const pending = client.ping(undefined, { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
  });
});

describe("sse stream", () => {
  const streamRpc = tacho();
  let cleaned = 0;
  const streamApp = streamRpc({
    ping: streamRpc.run(() => "pong"),
    ticks: streamRpc.run(async function* () {
      yield 0;
      yield 1;
      return 2;
    }),
    boom: streamRpc.run(async function* () {
      yield 0;
      throw new RpcError({ code: -32001, message: "nope", data: { x: 1 } });
    }),
    hang: streamRpc.run(async function* ({ ctx }) {
      try {
        yield 0;
        await new Promise<void>((resolve) => {
          const req = (ctx as { req?: Request }).req;
          if (!req || req.signal.aborted) return resolve();
          req.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        cleaned += 1;
      }
    }),
  });
  const streamHandler = handle(streamApp);
  const post = (body: unknown, init?: RequestInit) =>
    streamHandler(
      new Request("http://x/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...init,
      }),
    );

  test("yields then done", async () => {
    const res = await post({ jsonrpc: "2.0", method: "ticks", id: 1 });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(await res.text()).toBe(
      [
        'data: {"jsonrpc":"2.0","result":0,"id":1}\n',
        'data: {"jsonrpc":"2.0","result":1,"id":1}\n',
        'event: done\ndata: {"jsonrpc":"2.0","result":2,"id":1}\n',
        "",
      ].join("\n"),
    );
  });

  test("output schema checks each yield", async () => {
    const num = schema((v) =>
      typeof v === "number" ? { value: v } : { issues: [{ message: "num" }] },
    );
    const app = streamRpc({
      ok: streamRpc.output(num).run(async function* () {
        yield 0;
        yield 1;
        return 2;
      }),
      bad: streamRpc.output(num).run(async function* () {
        yield 0;
        yield "nope" as unknown as number;
      }),
    });
    const handler = handle(app);
    const post = (method: string) =>
      handler(
        new Request("http://x/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method, id: 1 }),
        }),
      );
    expect(await (await post("ok")).text()).toBe(
      [
        'data: {"jsonrpc":"2.0","result":0,"id":1}\n',
        'data: {"jsonrpc":"2.0","result":1,"id":1}\n',
        'event: done\ndata: {"jsonrpc":"2.0","result":2,"id":1}\n',
        "",
      ].join("\n"),
    );
    expect(await (await post("bad")).text()).toBe(
      [
        'data: {"jsonrpc":"2.0","result":0,"id":1}\n',
        'event: error\ndata: {"jsonrpc":"2.0","error":{"code":-32603,"message":"Invalid result","data":[{"message":"num"}]},"id":1}\n',
        "",
      ].join("\n"),
    );
    // @ts-expect-error yield must match output schema
    streamRpc.output(num).run(async function* () {
      yield "nope";
    });
  });

  test("throw becomes error event", async () => {
    const res = await post({ jsonrpc: "2.0", method: "boom", id: 1 });
    expect(await res.text()).toBe(
      [
        'data: {"jsonrpc":"2.0","result":0,"id":1}\n',
        'event: error\ndata: {"jsonrpc":"2.0","error":{"code":-32001,"message":"nope","data":{"x":1}},"id":1}\n',
        "",
      ].join("\n"),
    );
  });

  test("notification does not start the stream", async () => {
    const res = await post({ jsonrpc: "2.0", method: "ticks" });
    expect(res.status).toBe(204);
  });

  test("batch rejects only the stream item", async () => {
    const res = await post([
      { jsonrpc: "2.0", method: "ping", id: 1 },
      { jsonrpc: "2.0", method: "ticks", id: 2 },
    ]);
    expect(await res.json()).toEqual([
      { jsonrpc: "2.0", result: "pong", id: 1 },
      {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Streaming is not supported" },
        id: 2,
      },
    ]);
  });

  test("ws rejects streams", async () => {
    const hooks = handleWs(streamApp);
    const sent: unknown[] = [];
    await hooks.message(
      { context: {}, send: (data) => sent.push(data) },
      { text: () => JSON.stringify({ jsonrpc: "2.0", method: "ticks", id: 1 }) },
    );
    expect(sent.map((s) => (typeof s === "string" ? JSON.parse(s) : s))).toEqual([
      {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Streaming is not supported" },
        id: 1,
      },
    ]);
  });

  test("client iterates and return() cleans up", async () => {
    cleaned = 0;
    const client = createClient<typeof streamApp>({
      url: "http://x/rpc",
      fetch: ((i: RequestInfo | URL, init?: RequestInit) =>
        streamHandler(new Request(i, init))) as typeof fetch,
    });
    const ticks = await client.ticks();
    expect(await ticks.next()).toEqual({ value: 0, done: false });
    expect(await ticks.next()).toEqual({ value: 1, done: false });
    expect(await ticks.next()).toEqual({ value: 2, done: true });

    const hang = await client.hang();
    expect(await hang.next()).toEqual({ value: 0, done: false });
    await hang.return(undefined);
    await Promise.resolve();
    expect(cleaned).toBe(1);

    const boom = await client.boom();
    expect(await boom.next()).toEqual({ value: 0, done: false });
    await expect(boom.next()).rejects.toMatchObject({ message: "nope", code: -32001 });
  });

  test("circular reference in yielded value becomes error event, stream continues", async () => {
    const c = tacho();
    const a = c({
      circ: c.run(async function* () {
        const obj: { self?: unknown } = {};
        obj.self = obj;
        yield 0;
        yield obj;
        yield 1;
        return "done";
      }),
    });
    const h = handle(a);
    const res = await h(
      new Request("http://x/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "circ", id: 1 }),
      }),
    );
    const text = await res.text();
    // First yield succeeds
    expect(text).toContain('"result":0');
    // Second yield (circular) becomes a safe error frame, not a crash
    expect(text).toContain("error");
    expect(text).toContain("Internal error");
    // Third yield still arrives after the error
    expect(text).toContain('"result":1');
    // Done event still arrives
    expect(text).toContain('"result":"done"');
  });
});

describe("files", () => {
  const files = tacho();
  const fileSchema = schema((v) =>
    v instanceof File ? { value: v } : { issues: [{ message: "file" }] },
  );
  const echoSchema = schema((v) => {
    const rec = v as { file?: File; note?: string } | null;
    return rec?.file instanceof File && typeof rec.note === "string"
      ? { value: rec as { file: File; note: string } }
      : { issues: [{ message: "echo" }] };
  });
  const fileApp = files({
    echo: files.input(echoSchema).run(({ input }) => ({
      name: input.file.name,
      type: input.file.type,
      note: input.note,
    })),
    download: files.run(() => new File(["hello"], "hello.txt", { type: "text/plain" })),
    both: files.input(fileSchema).run(({ input }) => ({
      name: input.name,
      copy: new File(["out"], "out.txt", { type: "text/plain" }),
    })),
  });
  const fileHandler = handle(fileApp);
  const fileClient = createClient<typeof fileApp>({
    url: "http://x/rpc",
    fetch: ((i: RequestInfo | URL, init?: RequestInit) =>
      fileHandler(new Request(i, init))) as typeof fetch,
  });

  test("upload File next to json", async () => {
    const file = new File(["hi"], "hi.txt", { type: "text/plain" });
    expect(await fileClient.echo({ file, note: "ok" })).toMatchObject({
      name: "hi.txt",
      note: "ok",
    });
  });

  test("download File", async () => {
    const got = await fileClient.download();
    expect(got).toBeInstanceOf(File);
    expect(got.name).toBe("hello.txt");
    expect(got.type.startsWith("text/plain")).toBe(true);
    expect(await got.text()).toBe("hello");
  });

  test("upload and download together", async () => {
    const got = await fileClient.both(new File(["in"], "in.txt", { type: "text/plain" }));
    expect(got.name).toBe("in.txt");
    expect(got.copy).toBeInstanceOf(File);
    expect(got.copy.name).toBe("out.txt");
    expect(await got.copy.text()).toBe("out");
  });

  test("injectFiles refuses prototype paths and missing keys", () => {
    const file = new File(["x"], "x.txt");
    const before = Object.prototype.hasOwnProperty;
    const target = { file: null as File | null };
    expect(injectFiles(target, [{ path: ["__proto__", "polluted"], file }])).toEqual({
      file: null,
    });
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty).toBe(before);
    expect(injectFiles(target, [{ path: ["constructor"], file }])).toEqual({ file: null });
    expect(injectFiles(target, [{ path: ["missing"], file }])).toEqual({ file: null });
    expect(injectFiles(target, [{ path: ["file"], file }])).toEqual({ file });
  });

  test("download filename cannot break Content-Disposition", async () => {
    expect(safeFileName('evil\r\nSet-Cookie: a=1".txt')).toBe("evil__Set-Cookie: a=1_.txt");
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    const nasty = tacho()({
      download: tacho().run(
        () => new File(["x"], 'hi\r\nSet-Cookie: a=1".bin', { type: "text/plain" }),
      ),
    });
    const res = await handle(nasty)(
      new Request("http://x/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "download", id: 1 }),
      }),
    );
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).not.toMatch(/\r|\n/);
    expect(disposition).toBe('attachment; filename="hi__Set-Cookie: a=1_.bin"');
    expect(fileHeaders(new File(["x"], 'hi\r\nSet-Cookie: a=1".bin'))["content-disposition"]).toBe(
      disposition,
    );
  });
});

describe("toOpenRpc", () => {
  test("walks nested methods and uses input schema when present", () => {
    const spec = toOpenRpc(app, {
      title: "demo",
      version: "0.1.0",
      servers: [{ url: "https://api.example.com" }],
    });
    expect(spec.openrpc).toBe("1.3.2");
    expect(spec.info).toEqual({ title: "demo", version: "0.1.0" });
    expect(spec.servers).toEqual([{ url: "https://api.example.com" }]);
    expect(spec.methods.map((m) => m.name)).toEqual([
      "ping",
      "boom",
      "appErr",
      "user.get",
      "user.posts.list",
      "greet",
    ]);
    const ping = spec.methods.find((m) => m.name === "ping");
    expect(ping?.params).toEqual([]);
    expect(ping?.result).toEqual({ name: "result", schema: true });
    expect(ping?.errors?.some((e) => e.code === -32601)).toBe(true);
    expect(spec.methods.find((m) => m.name === "user.get")?.params).toEqual([
      { name: "params", schema: true, required: true },
    ]);
  });

  test("uses output schema when present", () => {
    const out = Object.assign(
      schema((v) => ({ value: v })),
      {
        "~standard": {
          validate: (v: unknown) => ({ value: v }),
          jsonSchema: { type: "string" },
        },
      },
    );
    const spec = toOpenRpc(rpc({ echo: rpc.output(out).run(() => "ok") }));
    expect(spec.methods[0]?.result).toEqual({ name: "result", schema: { type: "string" } });
  });
});

describe("security", () => {
  // --- prototype pollution via method dispatch ---

  test("__proto__ method dispatch is rejected over fetch", async () => {
    const body = await (await call({ jsonrpc: "2.0", method: "__proto__.toString", id: 1 })).json();
    expect(body.error.code).toBe(JSON_RPC_ERROR.METHOD_NOT_FOUND);
  });

  test("constructor.constructor method dispatch is rejected", async () => {
    const body = await (
      await call({ jsonrpc: "2.0", method: "constructor.constructor", id: 1 })
    ).json();
    expect(body.error.code).toBe(JSON_RPC_ERROR.METHOD_NOT_FOUND);
  });

  test("prototype chain walks via nested segments are rejected", async () => {
    for (const method of [
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
      "user.__proto__",
      "__defineGetter__",
      "__lookupGetter__",
    ]) {
      const body = await (await call({ jsonrpc: "2.0", method, id: 1 })).json();
      expect(body.error.code).toBe(JSON_RPC_ERROR.METHOD_NOT_FOUND);
    }
  });

  // --- error information leakage ---

  test("plain Error never leaks message or stack", async () => {
    const body = await (await call({ jsonrpc: "2.0", method: "boom", id: 1 })).json();
    expect(body.error.message).toBe("Internal error");
    expect(body.error.data).toBeUndefined();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("kaboom");
    expect(raw).not.toContain("stack");
    expect(raw).not.toContain("at ");
  });

  test("RpcError exposes only code, message, and data", async () => {
    const body = await (await call({ jsonrpc: "2.0", method: "appErr", id: 1 })).json();
    const keys = Object.keys(body.error);
    expect(keys.sort()).toEqual(["code", "data", "message"]);
    expect(body.error).not.toHaveProperty("stack");
  });

  test("top-level catch returns generic Internal error, not implementation details", async () => {
    // Send something that triggers the outer catch (createContext throwing)
    const badHandler = handle(app, {
      createContext: () => {
        throw new Error("DB_PASSWORD=secret123");
      },
    });
    const res = await badHandler(
      new Request("http://x/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toBe("Internal error");
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("DB_PASSWORD");
    expect(raw).not.toContain("secret123");
  });

  // --- content-type enforcement ---

  test("rejects text/plain content-type", async () => {
    const res = await fetchHandler(
      new Request("http://x/rpc", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      }),
    );
    expect(res.status).toBe(415);
  });

  test("rejects application/xml content-type", async () => {
    const res = await fetchHandler(
      new Request("http://x/rpc", {
        method: "POST",
        headers: { "content-type": "application/xml" },
        body: '<jsonrpc version="2.0"/>',
      }),
    );
    expect(res.status).toBe(415);
  });

  // --- batch size limits ---

  test("fetch transport enforces maxBatchSize", async () => {
    const smallBatch = handle(app, { maxBatchSize: 2 });
    const res = await smallBatch(
      new Request("http://x/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { jsonrpc: "2.0", method: "ping", id: 1 },
          { jsonrpc: "2.0", method: "ping", id: 2 },
          { jsonrpc: "2.0", method: "ping", id: 3 },
        ]),
      }),
    );
    const body = await res.json();
    expect(body.error.message).toBe("Batch too large");
  });

  test("default maxBatchSize rejects >20 items", async () => {
    const batch = Array.from({ length: 21 }, (_, i) => ({
      jsonrpc: "2.0",
      method: "ping",
      id: i + 1,
    }));
    const body = await (await call(batch)).json();
    expect(body.error.message).toBe("Batch too large");
  });

  // --- body size limit (content-length check) ---

  test("maxBodySize rejects when content-length exceeds limit", async () => {
    const limited = handle(app, { maxBodySize: 50 });
    const res = await limited(
      new Request("http://x/rpc", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "999999",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      }),
    );
    expect(res.status).toBe(413);
  });

  // --- malformed input resilience ---

  test("null body returns parse error", async () => {
    const body = await (await call("null")).json();
    expect(body.error.code).toBe(JSON_RPC_ERROR.INVALID_REQUEST);
  });

  test("numeric body returns invalid request", async () => {
    const body = await (await call("42")).json();
    expect(body.error.code).toBe(JSON_RPC_ERROR.INVALID_REQUEST);
  });

  test("string body returns parse error or invalid request", async () => {
    const body = await (await call('"hello"')).json();
    expect(body.error.code).toBe(JSON_RPC_ERROR.INVALID_REQUEST);
  });

  test("deeply nested JSON does not crash (parse succeeds, method resolves normally)", async () => {
    // 100 levels of nesting in params - should not crash the server
    let nested: unknown = "leaf";
    for (let i = 0; i < 100; i++) nested = { a: nested };
    const body = await (
      await call({ jsonrpc: "2.0", method: "ping", id: 1, params: [nested] })
    ).json();
    expect(body.result).toBe("pong");
  });

  // --- HTTP method enforcement ---

  test("GET, PUT, DELETE, PATCH all return 405", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const res = await fetchHandler(new Request("http://x/rpc", { method }));
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  // --- WebSocket security ---

  test("ws transport rejects __proto__ method", async () => {
    const hooks = handleWs(app);
    const sent: unknown[] = [];
    await hooks.message(
      { context: {}, send: (data) => sent.push(data) },
      { text: () => JSON.stringify({ jsonrpc: "2.0", method: "__proto__.toString", id: 1 }) },
    );
    const result = JSON.parse(sent[0] as string);
    expect(result.error.code).toBe(JSON_RPC_ERROR.METHOD_NOT_FOUND);
  });

  test("ws transport handles parse errors without crashing", async () => {
    const hooks = handleWs(app);
    const sent: unknown[] = [];
    await hooks.message(
      { context: {}, send: (data) => sent.push(data) },
      { text: () => "{invalid json" },
    );
    const result = JSON.parse(sent[0] as string);
    expect(result.error.code).toBe(JSON_RPC_ERROR.PARSE_ERROR);
  });

  test("ws transport error handler does not leak internals", async () => {
    const hooks = handleWs(app);
    const sent: unknown[] = [];
    await hooks.message(
      { context: {}, send: (data) => sent.push(data) },
      { text: () => JSON.stringify({ jsonrpc: "2.0", method: "boom", id: 1 }) },
    );
    const result = JSON.parse(sent[0] as string);
    expect(result.error.message).toBe("Internal error");
    expect(JSON.stringify(result)).not.toContain("kaboom");
    expect(JSON.stringify(result)).not.toContain("stack");
  });

  test("ws transport rejects oversized batch", async () => {
    const hooks = handleWs(app, { maxBatchSize: 2 });
    const sent: unknown[] = [];
    await hooks.message(
      { context: {}, send: (data) => sent.push(data) },
      {
        text: () =>
          JSON.stringify([
            { jsonrpc: "2.0", method: "ping", id: 1 },
            { jsonrpc: "2.0", method: "ping", id: 2 },
            { jsonrpc: "2.0", method: "ping", id: 3 },
          ]),
      },
    );
    const result = JSON.parse(sent[0] as string);
    expect(result.error.message).toBe("Batch too large");
    // default cap is 20
    const defaultHooks = handleWs(app);
    const big: unknown[] = [];
    const bigSent: unknown[] = [];
    await defaultHooks.message(
      { context: {}, send: (data) => bigSent.push(data) },
      {
        text: () =>
          JSON.stringify(
            Array.from({ length: 21 }, (_, i) => ({
              jsonrpc: "2.0",
              method: "ping",
              id: i + 1,
            })),
          ),
      },
    );
    const bigResult = JSON.parse(bigSent[0] as string);
    expect(bigResult.error.message).toBe("Batch too large");
    void big;
  });

  test("maxBodySize enforces actual body length, not just content-length header", async () => {
    const limited = handle(app, { maxBodySize: 20 });
    // No content-length header at all — the header check is bypassed,
    // but the actual body is measured after reading.
    const res = await limited(
      new Request("http://x/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      }),
    );
    expect(res.status).toBe(413);

    // Small body under the limit still works
    const tiny = JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }).slice(0, 10);
    const ok = await limited(
      new Request("http://x/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: tiny,
      }),
    );
    // slice(0,10) cuts the body — parse will fail, but not with 413
    expect(ok.status).not.toBe(413);
  });

  test("maxBodySize bounds multipart without Content-Length", async () => {
    const form = new FormData();
    form.set("rpc", JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }));
    form.set("maps", "[]");
    form.set("file", new File(["x".repeat(512)], "large.txt"));
    const res = await handle(app, { maxBodySize: 64 })(
      new Request("http://x/rpc", { method: "POST", body: form }),
    );
    expect(res.status).toBe(413);
  });

  // --- safeFileName header injection ---

  test("safeFileName strips CRLF, quotes, backslashes, and path separators", () => {
    expect(safeFileName("normal.txt")).toBe("normal.txt");
    expect(safeFileName('file"inject.txt')).toBe("file_inject.txt");
    expect(safeFileName("file\r\nCRLF.txt")).toBe("file__CRLF.txt");
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("path\\to\\file.txt")).toBe("path_to_file.txt");
    expect(safeFileName("")).toBe("download");
    // CRLF header injection attempt
    const injected = safeFileName("\r\nContent-Type: text/html\r\n\r\n<script>alert(1)</script>");
    expect(injected).not.toMatch(/[\r\n"\\]/);
  });

  test("fileHeaders Content-Disposition is safe with adversarial filenames", () => {
    const blob = new File(["x"], "\r\nHTTP/1.1 200\r\nX-Bad: true", { type: "text/plain" });
    const headers = fileHeaders(blob);
    expect(headers["content-disposition"]).not.toMatch(/[\r\n]/);
    expect(headers["content-disposition"]).toContain('filename="');
  });
});

describe("same-origin protection", () => {
  const app = tacho()({ ping: tacho().run(() => "pong") });
  const body = JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 });
  const call = (handler: ReturnType<typeof handle>, headers: Record<string, string>) =>
    handler(
      new Request("http://x/rpc", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      }),
    );

  test("rejects cross-site and cross-origin POSTs when sameOrigin: true", async () => {
    const handler = handle(app, { sameOrigin: true });
    expect((await call(handler, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await call(handler, { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await call(handler, { "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await call(handler, { origin: "http://evil.com" })).status).toBe(403);
    expect((await call(handler, { origin: "http://x" })).status).toBe(200);
    // no Origin / Sec-Fetch-Site (curl, server-to-server) is allowed
    expect((await call(handler, {})).status).toBe(200);
  });

  test("sameOrigin defaults to off", async () => {
    const open = handle(app);
    expect((await call(open, { "sec-fetch-site": "cross-site" })).status).toBe(200);
  });
});

describe("sse client extras", () => {
  test("client parses CRLF SSE frames", async () => {
    const sse = [
      'id: 1\r\ndata: {"jsonrpc":"2.0","result":0,"id":1}\r\n\r\n',
      'id: 2\r\nevent: done\r\ndata: {"jsonrpc":"2.0","result":1,"id":1}\r\n\r\n',
    ].join("");
    const client = createClient({
      url: "http://x/rpc",
      fetch: (async () =>
        new Response(sse, {
          headers: { "content-type": "text/event-stream" },
        })) as unknown as typeof fetch,
    }) as unknown as { ticks: () => Promise<AsyncGenerator<unknown>> };
    const gen = await client.ticks();
    expect(await gen.next()).toEqual({ value: 0, done: false });
    expect(await gen.next()).toEqual({ value: 1, done: true });
  });

  test("heartbeat emits comment frames", async () => {
    const app = tacho()({
      wait: tacho().run(async function* () {
        yield 0;
        await new Promise(() => {});
      }),
    });
    const res = await handle(app, { heartbeatMs: 5 })(
      new Request("http://x/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "wait", id: 1 }),
      }),
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (let i = 0; i < 50 && !text.includes(": ping"); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain(": ping");
    await reader.cancel();
  });
});
