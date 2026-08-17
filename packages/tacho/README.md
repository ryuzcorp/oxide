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
- **Runtime-agnostic** — `handle()` is `(Request) => Response`. srvx, Bun, Workers, Node.
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

Plain `Error` becomes `INTERNAL_ERROR` (`-32603`) with the message kept, no stack.

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

| option          |                                                           |
| --------------- | --------------------------------------------------------- |
| `path`          | Other paths → 404.                                        |
| `createContext` | Merged onto `{ req }`. Throw → JSON-RPC `INTERNAL_ERROR`. |
| `onError`       | Called when `createContext` or the stream throws.         |

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

| option    |                                                            |
| --------- | ---------------------------------------------------------- |
| `url`     | POST target.                                               |
| `headers` | Object or `() => HeadersInit \| Promise<HeadersInit>`.     |
| `signal`  | Default abort. Per-call: `client.ping(input, { signal })`. |
| `fetch`   | Custom `fetch`.                                            |

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

`async function*` over fetch becomes SSE. Same client call, `for await` the result. WS and batch reject streams. Notifications to a stream procedure are 204 and do not start the generator.

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

Wire: each `yield` is `data: { jsonrpc, id, result }`. Handler `return` is `event: done`. Throw is `event: error`.

## WebSocket

Server via [crossws](https://github.com/h3js/crossws) (optional peer). Same `path` / `createContext` / `onError` as fetch.

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

## Wire

JSON-RPC 2.0, POST only.

- No `id` → notification (HTTP 204 / no WS message)
- `[]` → single `INVALID_REQUEST`, not an array
- Notification-only batch → no response
- `rpc.*` → `METHOD_NOT_FOUND`
- Non-POST → 405 + `Allow: POST`
- Stream + batch → `INVALID_REQUEST`
- Stream over WS → `INTERNAL_ERROR` (`Streaming is not supported`)
