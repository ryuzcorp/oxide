# tacho

JSON-RPC, but you never write a client. Tiny, typed end-to-end, with streaming, file uploads, and middleware built in — runtime-agnostic by design.

```sh
npm i tacho
```

```ts
import { serve } from "srvx";
import { tacho } from "tacho";
import { handle } from "tacho/transport/fetch";
import { createClient } from "tacho/client/http";
import { z } from "zod";

const rpc = tacho<{ req: Request }>();

export const router = rpc({
  ping: rpc.run(() => "pong" as const),
  user: {
    get: rpc
      .input(z.object({ id: z.string() }))
      .run(({ input }) => ({ id: input.id, name: "Ada" })),
  },
});

export type Router = typeof router;

await router.ping(); // "pong" — no transport
await router.user.get({ id: "1" });

serve({ fetch: handle(router), port: 3000 });

const client = createClient<Router>({ url: "http://localhost:3000" });
await client.ping(); // "pong"
await client.user.get({ id: "1" }); // { id: "1", name: "Ada" }
```

## Why

- **Typed end to end** — `typeof router` is the client. Nested paths are `user.get`.
- **Just JSON-RPC** — batch, notifications, `rpc.*` reserved. Works with any JSON-RPC client.
- **Runtime-agnostic** — `handle()` is `(Request) => Promise<Response>`. srvx, Bun, Workers, Node.
- **Bring your schema** — `zod`, `valibot`, `arktype`, …
- **Onion middleware** — `return next({ ctx })`. Skip `next()` to skip the handler.
- **SSE streams** — `async function*` over fetch. `for await` on the client.
- **Files** — pass `File` / `Blob` in params or return them. Fetch uses multipart automatically.

## `tacho()`

Creates a procedure builder. Call it as `rpc({ ... })` to make a router. Procedures are callable in-process: `await router.ping()`.

```ts
const rpc = tacho<{ req: Request; user?: string }>();

export const router = rpc({
  ping: rpc.run(() => "pong" as const),
  user: {
    get: rpc.input(z.object({ id: z.string() })).run(({ input }) => input),
  },
});
```

### `.input(schema)`

Any [Standard Schema](https://standardschema.dev/) (`zod`, `valibot`, `arktype`, …). Failed validation is `INVALID_PARAMS` (`-32602`).

```ts
user: {
  get: rpc
    .input(z.object({ id: z.string() }))
    .run(({ input }) => ({ id: input.id, name: "Ada" })),
}
```

No `.input()` → params are untyped / unused.

### `.output(schema)`

Same Standard Schema as `.input()`. Failed validation is `INTERNAL_ERROR` (`-32603`, `Invalid result`). The handler return type must match; the IDE flags a mismatch. Streams check each `yield` (and a defined `return`).

```ts
user: {
  get: rpc
    .input(z.object({ id: z.string() }))
    .output(z.object({ id: z.string(), name: z.string() }))
    .run(({ input }) => ({ id: input.id, name: "Ada" })),
}
```

### `.run(fn)`

Terminal. `fn` gets `{ input, ctx }`. Return a value, a `Promise`, or an `async function*` (stream).

```ts
rpc.run(({ input, ctx }) => ({ id: input.id, ip: ctx.req.headers.get("x-forwarded-for") }));
```

### `.use(mw)`

Onion middleware. `return next({ ctx })` continues and merges context. Skip `next()` to skip the handler. `await next()` to wrap the result.

```ts
import { RpcError } from "tacho";

const protect = rpc.use(async ({ ctx, next }) => {
  const user = ctx.req.headers.get("x-user");
  if (!user) throw new RpcError({ code: -32001, message: "unauthorized" });
  return next({ ctx: { user } });
});

export const router = rpc({
  me: protect.run(({ ctx }) => ctx.user),
  greet: protect.use(async ({ next }) => `hi ${await next()}`).run(({ ctx }) => ctx.user),
  cached: protect.use(async () => "from-cache").run(() => "handler"),
});
```

## `RpcError`

Throw from a procedure or middleware to send a custom JSON-RPC error.

```ts
import { APP_ERROR_RANGE, JSON_RPC_ERROR, RpcError } from "tacho";

rpc.run(() => {
  throw new RpcError({ code: -32001, message: "nope", data: { retry: true } });
});

JSON_RPC_ERROR.PARSE_ERROR; // -32700
JSON_RPC_ERROR.INVALID_REQUEST; // -32600
JSON_RPC_ERROR.METHOD_NOT_FOUND; // -32601
JSON_RPC_ERROR.INVALID_PARAMS; // -32602
JSON_RPC_ERROR.INTERNAL_ERROR; // -32603
APP_ERROR_RANGE; // { min: -32099, max: -32000 }
```

Plain `Error` becomes `INTERNAL_ERROR` (`-32603`) with a generic message. No stack or original message is leaked. Only `RpcError` messages are forwarded to the client.

> **Security:** `RpcError.data` is serialized to the wire. Never put secrets, stack traces, or internal state in it.

## Fetch

`handle(router, opts?)` from `tacho/transport/fetch` is `(Request) => Promise<Response>`. POST only. Puts `req` on context. CORS is not built in — wrap `handle()`.

```ts
import { handle } from "tacho/transport/fetch";

serve({
  fetch: handle(router, {
    path: "/rpc",
    createContext: (req) => ({ user: req.headers.get("x-user") ?? undefined }),
    onError: (err, req) => console.error(req.url, err),
  }),
});
```

| option          |                                                                |
| --------------- | -------------------------------------------------------------- |
| `path`          | Other paths -> 404.                                            |
| `createContext` | Merged onto `{ req }`. Throw -> JSON-RPC `INTERNAL_ERROR`.     |
| `onError`       | Called when `createContext` or the stream throws.              |
| `maxBodySize`   | Max request body in bytes. Default: `1_048_576` (1 MB).        |
| `maxBatchSize`  | Max items in a batch request. Default: `20`.                   |
| `serializer`    | Custom serializer (e.g. superjson, msgpack). See below.        |
| `sameOrigin`    | Reject cross-origin requests (CSRF defense). Default: `false`. |
| `heartbeatMs`   | Emit SSE heartbeat comments every `value` ms. Default: none.   |

## HTTP client

`createClient` from `tacho/client/http`. Typed proxy over POST.

```ts
import { createClient } from "tacho/client/http";

const client = createClient<Router>({
  url: "http://localhost:3000",
  headers: () => ({ authorization: `Bearer ${token}` }),
  signal: AbortSignal.timeout(5_000),
  fetch: myFetch,
});

await client.ping();
await client.user.get({ id: "1" });
await client.ping(undefined, { signal: AbortSignal.timeout(1_000) });
```

| option       |                                                            |
| ------------ | ---------------------------------------------------------- |
| `headers`    | Object or `() => HeadersInit \| Promise<HeadersInit>`.     |
| `signal`     | Default abort. Per-call: `client.ping(input, { signal })`. |
| `fetch`      | Custom `fetch`.                                            |
| `serializer` | Custom serializer.                                         |

## Query cache

Every HTTP client ships a `.query()` surface that caches by RPC method path and input, plus a `.cache` handle to control it.

```ts
const client = createClient<Router>({ url: "http://localhost:3000" });

await client.user.get({ id: "1" }); // always hits the wire
await client.query().user.get({ id: "1" }); // cached with key ["user.get", { id: "1" }]
await client.query({ key: ["user", "1"] }).user.get({ id: "1" }); // custom key
```

The default key is `[methodPath, input]`, hashed stably — object key order does not matter. Identical in-flight calls dedupe into one request. Errors are never cached: a failed call drops its entry so the next call retries. Streams (`async function*`) and file uploads bypass the cache. You can also set `staleTime` on `query(opts)`:

```ts
const q = client.query({ staleTime: 30_000 });
await q.list(); // fresh for 30s
```

Cache control via `.cache`:

```ts
await client.cache.invalidate(); // drop everything
await client.cache.invalidate(["user.get"]); // prefix match on method path segments
await client.cache.invalidate((e) => e.method.startsWith("task."));
await client.cache.invalidate(["user.get"], { refetch: true }); // re-run stored params now
client.cache.keys();
client.cache.clear();
```

After a mutation, invalidate what it touched:

```ts
const name = await client.user.rename({ id: "1", name: "Ada" });
await client.cache.invalidate(["user.get"], { refetch: true });
```

Caveat: a router with root-level `query` or `cache` procedures shadows them on the typed surface.

## Custom Serializers

To use a custom serializer (like `superjson` or `msgpack`), pass it to `handle()` and `createClient()`.

```ts
import superjson from "superjson";
import type { Serializer } from "tacho";

const serializer: Serializer = {
  stringify: (val) => superjson.stringify(val),
  parse: (val) => superjson.parse(val as string),
  contentType: "application/superjson", // optional, defaults to application/json
};

// Server
serve({
  fetch: handle(router, { serializer }),
});

// Client
const client = createClient<Router>({ url: "...", serializer });
```

Binary serializers like `msgpack` just work. Pass `Uint8Array` to/from `parse` and `stringify`. Note: binary serialization is not compatible with SSE streams (`async function*`).

## Files

`File` and `Blob` are first-class. Mix them with objects. Fetch switches to multipart when needed; JSON stays JSON. A lone returned `File` is a download (`Content-Disposition`). Local `router.upload(file)` just works.

```ts
export const router = rpc({
  upload: rpc.run(({ input }: { input: { file: File; note: string } }) => input.file.name),
  download: rpc.run(() => new File(["hello"], "hello.txt", { type: "text/plain" })),
});

await client.upload({ file: new File(["hi"], "hi.txt"), note: "ok" });
const file = await client.download();
await file.text(); // "hello"
```

## Stream

`async function*` over fetch becomes SSE. Same client call, `for await` the result. WS requests and stream items inside batches return `INTERNAL_ERROR`. Other batch items still run. Notifications to a stream procedure are 204 and do not start the generator.

```ts
export const router = rpc({
  ticks: rpc.input(z.object({ n: z.number() })).run(async function* ({ input }) {
    for (let i = 0; i < input.n; i++) yield { i };
  }),
});

const ticks = await client.ticks({ n: 3 });
for await (const t of ticks) console.log(t.i);
await ticks.return();
```

## Publisher

In-memory pub/sub for live updates: one procedure publishes, a stream procedure subscribes. Events are typed. Plain Map/Set — runs on Bun, Node, and Workers (workerd). One instance lives in exactly one isolate: inside a Durable Object, keep the publisher and its stream procedures in the same cell.

```ts
import { Publisher } from "tacho";

const events = new Publisher<{ "task-added": { id: string } }>();

export const router = rpc({
  add: rpc.run((input: { id: string }) => {
    events.publish("task-added", input);
  }),
  live: rpc.run(async function* ({ signal }) {
    for await (const e of events.subscribe("task-added", { signal })) yield e;
  }),
});
```

Dynamic channels work too — type the map with a string index:

```ts
const messages = new Publisher<Record<string, { text: string }>>();
messages.publish("room-42", { text: "hi" });
const next = await messages.once("room-42", { signal }); // one-shot wait, undefined if aborted
```

Memory-only, no replay or resume. Cross-cell or durable events need stub RPC / storage (Redis, Durable Object alarms + storage).

`subscribe` returns a standard async generator, so it plugs into anything that consumes one — `Stream.fromAsyncIterable(publisher.subscribe("task-added", { signal }), cause => new Error(String(cause)))` for Effect, `from(generator)` for RxJS.

Wire: each `yield` is `data: { jsonrpc, id, result }`. Handler `return` is `event: done`. Throw is `event: error`. Streams set `Cache-Control: no-store` and `X-Accel-Buffering: no`. Passing `heartbeatMs` to `handle()` emits `: ping` comment frames to keep idle connections alive.

Dropped streams end. Tacho does not reconnect automatically because replaying the POST could run procedure side effects twice. Resume needs application-specific event IDs and server-side state.

## WebSocket

Server via [crossws](https://github.com/h3js/crossws) (optional peer). Same `path`, `createContext`, `onError`, `serializer`, `sameOrigin`, and `maxBatchSize` options as fetch. `sameOrigin` rejects cross-origin browser upgrades; `maxMessageSize` defaults to 1 MB.

> **Security:** The WS handler does not authenticate connections by default. Use `createContext` to verify credentials on every message. An unauthenticated socket can call any procedure.

```ts
import { handle } from "tacho/transport/ws";
import { serve } from "crossws/server";

serve({
  websocket: handle(router, {
    path: "/rpc",
    createContext: (peer) => ({ user: String(peer.context["user"] ?? "") }),
    onError: (err) => console.error(err),
  }),
});
```

Client from `tacho/client/ws`. One socket. `.ready` and `.close()`.

```ts
import { createClient } from "tacho/client/ws";

const ws = createClient<Router>({
  url: "ws://localhost:3000",
  protocols: "tacho",
  WebSocket: MyWebSocket,
});
await ws.ready;
await ws.ping();
ws.close();
```

Per-call `{ signal }` stops waiting for that response. It does not cancel work already running on the server.

## Low-level

For custom transports.

```ts
import { resolveProcedure, rpcResult, runBatch, runOne } from "tacho";

resolveProcedure(router, "user.get"); // procedure or undefined
await runOne(router, { jsonrpc: "2.0", method: "ping", id: 1 }, { req });
await runBatch(router, [{ jsonrpc: "2.0", method: "ping", id: 1 }], { req });
rpcResult({ result: "pong" }); // "pong"
rpcResult({ error: { message: "nope", code: -32603 } }); // throws RpcError
```

`createProxyClient(send)` builds a typed proxy over your own send function.

## OpenRPC

`toOpenRpc(router)` walks procedures into an [OpenRPC](https://spec.open-rpc.org/) document. Input/output schemas are used when the Standard Schema exposes `jsonSchema`; otherwise `true`. Methods list the JSON-RPC + app error codes.

```ts
import { toOpenRpc } from "tacho";

const spec = toOpenRpc(router, {
  title: "My API",
  version: "1.0.0",
  servers: [{ url: "https://api.example.com" }],
});
```

## Security

### Default guards

| Guard                     | Default                                                     | What fails                                                                                                              |
| ------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Method dispatch**       | `Object.hasOwn` walk                                        | `__proto__`, `constructor`, prototype chain segments → `METHOD_NOT_FOUND`                                               |
| **HTTP method**           | POST only                                                   | GET / PUT / DELETE / PATCH → `405` + `Allow: POST`                                                                      |
| **Content-Type**          | `application/json`                                          | `text/plain`, `application/xml` → `415`                                                                                 |
| **Body size**             | 1 MB (`maxBodySize`)                                        | Oversized body → `413`. Measured on the _actual_ body, not just the `Content-Length` header.                            |
| **Batch size**            | 20 (`maxBatchSize`)                                         | Fetch _and_ WS enforce the same cap. Oversized → `INVALID_REQUEST`.                                                     |
| **Error info**            | Plain `Error` → generic `"Internal error"`                  | Original message, stack, and data are never serialized. `RpcError` exposes only `code`, `message`, and explicit `data`. |
| **Procedure name**        | `rpc.*` reserved                                            | `rpc.discover` → `METHOD_NOT_FOUND`                                                                                     |
| **Stream + batch**        | Rejected                                                    | `INVALID_REQUEST`                                                                                                       |
| **Stream + notification** | No-op                                                       | `204`, generator never starts                                                                                           |
| **Content-Disposition**   | `safeFileName` strips `\r`, `\n`, `"`, `\`, path separators | `fileHeaders` returns a safer `filename` value                                                                          |

`handle()` returns a plain `(Request) => Response`. It does no rate limiting, no CORS, and no authentication — those are your server's job.

> **CSRF** — set `sameOrigin: true` to reject cross-origin / cross-site requests. It checks `Sec-Fetch-Site`, then `Origin`. Requests with neither (server-to-server, curl) are allowed.

### What you must guard

- **CORS** — `handle()` does not set `Access-Control-*` headers. Wrap it when called cross-origin.
- **Rate limiting** — No built-in. Use a middleware-like wrapper on `handle()` or an upstream reverse proxy.
- **WebSocket authentication** — The WS handler's `upgrade()` only checks `path`. Authenticate via `createContext` or guard at the upgrade point from the server's WebSocket upgrade handler.

### Custom serializers

A custom `parse` / `stringify` is the full trust boundary — whatever the serializer writes to the wire, the client sees. If you use one, it is responsible for not leaking internals.

## Wire

JSON-RPC 2.0, POST only.

- No `id` → notification (HTTP 204 / no WS message)
- `[]` → single `INVALID_REQUEST`, not an array
- Notification-only batch → no response
- `rpc.*` → `METHOD_NOT_FOUND`
- Non-POST → 405 + `Allow: POST`
- Stream in batch → that item gets `INTERNAL_ERROR`; other items still run
- Stream over WS → `INTERNAL_ERROR` (`Streaming is not supported`)
