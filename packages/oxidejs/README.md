# oxidejs

One build command → a deployable tree:

```
dist/
├── client/           # only if index.html exists
└── server.js         # ESM server bundle
```

`preset: "worker"` also writes `dist/wrangler.jsonc` with `main: "./server.js"`.

v1 targets **Vite** and **Rsbuild** via unplugin. Other bundlers are out of scope for now.

The `oxidejs` entry exports runtime helpers (`action`, `useRequest`, …). The bundler plugin lives at `oxidejs/vite` or `oxidejs/rsbuild` — keep those separate so `*.server.ts` can import `oxidejs` under `preset: "worker"` without pulling Node build tooling into the worker graph.

## Vite

```ts
// vite.config.ts
import { defineConfig } from "vite";
import oxide from "oxidejs/vite";

export default defineConfig({
  plugins: [oxide()],
});
```

```json
// tsconfig.json
{ "extends": "oxidejs/tsconfig" }
```

```bash
vite build
node dist/server.js
```

Default preset is `"fetch"`. No `index.html` → only `dist/server.js`. With `index.html` → client to `dist/client/`, then `/__oxide/action` (if you have a `*.server.{ts,tsx,js,jsx}` file) → `src/server.ts` when present (`undefined` continues) → static file → `index.html` for navigations. Missing the default `src/server.ts` is fine — actions and static assets still run. `public/` is copied next to the client. Hashed assets get `Cache-Control: immutable`. No `wrangler.jsonc`.

```ts
oxide({
  preset: "worker",
  wrangler: { name: "my-app", compatibility_date: "2026-01-01" },
});
```

`"worker"` writes `dist/wrangler.jsonc` for Cloudflare Workers / celld and skips asset serving (`ASSETS` does that). With a client build, oxide sets `assets.not_found_handling: "single-page-application"` and, when `ASSETS.fetch` returns 404 for a document navigation, retries `/index.html` so SPA routes like `/login` work. The generated worker imports `oxidejs/worker-dom/install` so Ilha SSR has a DOM before your entry evaluates. Pass `compatibility_flags` when you need them (`nodejs_compat` is optional — celld ignores it). Cloudflare-only keys (`account_id`, `workers_dev`, `routes`) are emitted when you set them for wrangler deploy; **omit them for celld** — unknown top-level keys fail `celld deploy`.

## Server actions

Files named `*.server.ts`, `*.server.tsx`, `*.server.js`, or `*.server.jsx` are server-only. A client import is replaced with an Effect RPC stub that POSTs `/__oxide/action` as newline-delimited JSON-RPC (`application/json-rpc`). The original module never enters the client graph. **Only exports wrapped in `action()` become remote actions** — any other export stays server-local and is not callable over the wire. Server and Vite SSR (`import.meta.env.SSR === true`) keep the real functions. Methods are `<file>.<fn>` (`test.ping`). Call `useRequest()` inside an action for the inbound `Request`. `useCtx()` is the request context (`{ req }` plus anything middleware stamped via `stampRequestContext`, or `createContext` added). On `preset: "worker"`, `useEnv()` and `useFetchCtx()` are the Worker `env` and `ctx` from `fetch(request, env, ctx)` — same values as `useCtx().env` / `useCtx().fetchCtx`. Middleware runs before the action gate and before WebSocket upgrade so stamped fields are visible to WS actions. Return `undefined` from `src/server.ts` to fall through to static files. No server action files → the bundle does not import `oxidejs/rpc`. `action()` results are JSON-RPC data — returning a `Response` from an action is an error; return a raw `Response` from `src/server.ts` for raw HTTP responses.

```ts
// src/test.server.ts
import { action, useRequest } from "oxidejs";

export const who = action(async () => {
  return useRequest().headers.get("x-user");
});

export const ping = action(async () => "pong");

// a non-action export is never exposed over the wire
async function internalHelper() {
  /* server-only */
}

// src/client.ts
import { ping } from "./test.server";
console.log(await ping()); // "pong"

// src/server.ts
import type { FetchHandler } from "oxidejs";

export const fetch = ((request) => {
  if (new URL(request.url).pathname === "/api/ok") return new Response("ok");
  return;
}) satisfies FetchHandler;
```

### Call shape

Unary actions return a Promise and expose helpers for UI wiring:

| Call | What it does |
| --- | --- |
| `await ping()` | Run the action (always invokes RPC on client) |
| `ping.set(...args)` | Same as calling with args; also writes the atom |
| `ping.bind(...args)` / `ping.with(...args)` | Return an event handler that invokes the action |
| `ping.result` | Read the last `AsyncResult` from the client atom |

Validate a single payload with Effect Schema via `withSchema` or `action(fn, { payload })` (keep `action()` as the outer call):

```ts
import { Schema } from "effect";
import { action, withSchema } from "oxidejs";

const AddTask = Schema.Struct({ text: Schema.String });

export const add = action(
  withSchema(AddTask, async ({ text }) => {
    /* text: string */
  })
);
```

The client arg is the schema's Encoded type; the handler receives Type. Decode failures over RPC map to JSON-RPC Invalid params (`-32602`). Optional `success` / `error` schemas stamp the generated Rpc tag; use `Schema.TaggedError` + `Effect.fail` for wire-typed Fail (`-32000` after scrub).

`action()` also accepts `Effect` handlers — prefer them for domain Fail (`Schema.TaggedError` + `Effect.fail`). Yield `OxideRequest` / `OxideCtx` for the same values as `useRequest()` / `useCtx()`. Effect `Stream` returns need `{ stream: true }` (or return a `Stream` — Fail channels are typed). Handlers run under an `oxidejs.action` span (`rpc.method`).

Provide `oxideRuntimeLayer()` at the host if you want those spans / logs collected:

```ts
import { Effect } from "effect";
import { oxideRuntimeLayer } from "oxidejs";

await Effect.runPromise(myEffect.pipe(Effect.provide(oxideRuntimeLayer())));
```

`action()` marks the export and adds a typed transport-only `{ signal }` argument. Wrap `async function*` in it to stream over Effect RPC as newline-delimited JSON-RPC (not SSE). On the client the stub returns an async generator — iterate it directly. Inside server code, always read the non-optional signal from `useRequest().signal`:

```ts
// src/test.server.ts
import { action, useRequest } from "oxidejs";

export const ticks = action(async function* (n: number) {
  const { signal } = useRequest();
  for (let i = 0; i < n && !signal.aborted; i++) yield i;
});

// src/client.ts
import { ticks } from "./test.server";

const ac = new AbortController();
for await (const value of ticks(10, { signal: ac.signal })) {
  console.log(value);
}
ac.abort();
```

Stream actions do not support `bind` / `with`. Breaking the `for await` loop or calling `return()` on the generator cleans up the server generator.

### Live queries

Use `liveQuery` / `publish` for snapshot streams (query = subscription, mutation = publish). Hubs are isolate-local Effect PubSub — D1 (or your DB) stays the source of truth. Prefer Effect `Stream` + `mutateEffect`:

```ts
import { Effect, Stream } from "effect";
import { action, liveQuery } from "oxidejs";

const tasks = liveQuery<Task[]>({ topic: "tasks" });

export const list = action(
  () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const db = requireDb();
        return tasks.subscribeStream(
          tasks.mutateEffect(() => snapshot(db)).pipe(Effect.asVoid)
        );
      })
    ),
  { stream: true }
);

export const add = action((text: string) =>
  Effect.gen(function* () {
    const db = requireDb();
    yield* tasks.mutateEffect(() =>
      Effect.gen(function* () {
        yield* insert(db, text);
        return yield* snapshot(db);
      })
    );
  })
);
```

`subscribe` / `mutate` (Promise + async generator) remain for compatibility.

**SSR → live socket handoff:** under SSR / the server graph, `*.server.ts` keeps the real generator (no WebSocket). Ilha `Stream.take(1)` paints the first snapshot. On the client, the stub resumes the same method over `actions: "ws"`. Oxide retries transient closes (`1000` / `1001` / `1006`) inside the stream client so hydrate does not paint `SocketCloseError`. Abort via `{ signal }` does not retry.

Keep UI out of `*.server.*`. One `Stream.fromAsyncIterable(list(), …)` consumer is enough.

### Workflows (worker)

Durable multi-step jobs on Cloudflare Workflows / celld. Export `workflow()` from a `*.server.ts` file — oxide emits the `WorkflowEntrypoint` class, merges `[[workflows]]` into `wrangler.jsonc`, and exposes `start` / `status` / `send` over the same action RPC.

```ts
// src/invoice.server.ts
import { Schema } from "effect";
import { workflow } from "oxidejs";

const Params = Schema.Struct({ orderId: Schema.String });

export const invoice = workflow({
  name: "invoice",
  payload: Params,
  run: async ({ payload }, step) => {
    const charged = await step.do("charge", () => charge(payload.orderId));
    await step.sleep("settle", "1 day");
    return charged;
  },
});

// client or server
import { invoice } from "./invoice.server";

const { id } = await invoice.start({ orderId: "…" });
const status = await invoice.status(id);
```

Defaults: binding `INVOICE`, class `InvoiceWorkflow`. Override with `binding` / `className` (string literals — the build scanner does not evaluate variables). Pass `{ idempotencyKey }` on `start` for a stable instance id. Retries with the same id reuse the existing instance (`create` is not idempotent on Cloudflare; oxide falls back to `get`). Keep side effects inside `step.do` — the runtime replays `run()` from the start. Requires `preset: "worker"`. Do not use the same workflow `name` as a `*.server.ts` module key that also exports `action()`s. `status` returns `{ status: "not_found" }` when the instance does not exist yet (e.g. right after a queue `send`, before the consumer creates it) instead of an Internal error. A Vercel / fetch driver is not wired yet.

### Queues (worker)

Buffer work, then start a workflow per message (durable / resumable). Export `queue()` from a `*.server.ts` file next to the workflow it drives:

```ts
// src/invoice.server.ts
import { Schema } from "effect";
import { queue, workflow } from "oxidejs";

const Params = Schema.Struct({ orderId: Schema.String });

export const invoice = workflow({
  name: "invoice",
  payload: Params,
  run: async ({ payload }, step) => {
    await step.do("charge", () => charge(payload.orderId));
  },
});

export const invoices = queue({
  name: "invoices",
  workflow: invoice,
});

await invoices.send({ orderId: "…" });
await invoices.sendBatch([{ body: { orderId: "…" } }]);
```

Oxide merges `queues.producers` / `queues.consumers` into `wrangler.jsonc` and attaches a same-worker `queue` handler that starts the workflow from each message (via `createBatch` when available, otherwise duplicate-aware `create`/`get`). Cloudflare does not return message ids from `send`, so oxide wraps bodies in an envelope with a client-chosen id (`{ idempotencyKey }` / request header / UUID) and returns `{ id }` from `send` (and `{ ids }` from `sendBatch`) for `workflow.status` polling. Queue transport options (`contentType` / `delaySeconds`) travel in the RPC payload; `signal` / `idempotencyKey` stay on `CallOptions`.

```ts
const { id } = await invoices.send({ orderId: "…" });
const status = await invoice.status(id);
```

Optional `handle` replaces auto-start (unwrap with `readQueueEnvelope`). Optional `maxBatchSize` / `maxBatchTimeout` / `maxRetries` stamp the consumer entry. Optional `producerStart: true` also starts the workflow from `send` / `sendBatch` (same envelope id) for hosts like celld that do not run a same-worker queue consumer alongside `fetch()` — default is off so Cloudflare queue semantics (backpressure, batching, retries) control execution. Delayed messages (`delaySeconds`) still need a host that runs `queue`.

Queue `name` must not match a workflow `name` (Rpc tags would collide on `.send`) or an action module key. Defaults: binding `INVOICES` from `name`.

**celld queues:** set `producerStart: true` on the queue (kit does this for the demo). Oxide still emits the same-worker consumer for Cloudflare. Create-after-enqueue failures are soft-failed so the client does not see a false send failure.

### Schedules (worker)

Cron ticks that start a workflow (or enqueue / run a custom `handle`). Export `schedule()` from a `*.server.ts` file:

```ts
export const invoice = workflow({
  name: "invoice",
  payload: Params,
  run: async ({ payload }, step) => {
    await step.do("charge", () => charge(payload.orderId));
  },
});

export const nightly = schedule({
  name: "nightly",
  cron: "0 3 * * *",
  workflow: invoice,
  params: { orderId: "batch" },
});
```

Exactly one of `workflow` / `queue` / `handle`. Oxide merges unique cron expressions into wrangler `triggers.crons` and attaches a same-worker `scheduled` handler. Each tick starts the workflow with id `` `${name}:${scheduledTime}` `` (idempotent retries). `params` may be a value or `(event) => value`; payload schema comes from the workflow/queue handle.

### Mutation queue (client)

Optional offline write queue for WebSocket actions. `flush` retries transient failures with Effect `Schedule.exponential` + jitter:

```ts
import { createMutationQueue } from "oxidejs/mutation-queue";
import { add } from "./tasks.server";

const queue = createMutationQueue({
  retries: 4,
  retryBase: "50 millis",
});
const addQueued = queue.wrap(add, {
  idempotencyKey: (text) => `add:${text}`,
});

await addQueued("Milk"); // runs now, or enqueues on transient WS failure
window.addEventListener("online", () => void queue.flush());
```

`wrap` forwards the queue id as trailing `{ idempotencyKey }`. That key is sent as RPC header `x-oxide-idempotency-key` and available as `useIdempotencyKey()` on the server. Pair with paranorm `once()` for durable dedupe.

### WebSocket hibernation

Default Worker upgrades call `server.accept()`. That is fine for low fan-out (kit). For many idle clients, route the action upgrade into a Durable Object and hibernate with `acceptWebSocket`:

```ts
import { createWsHooks } from "oxidejs/rpc";

export class ActionRoom {
  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {}

  async fetch(request: Request) {
    const hooks = createWsHooks(group, handlers, {
      accept: (ws) => this.state.acceptWebSocket(ws),
      path: "/__oxide/action",
    });
    const upgraded = hooks.handleUpgrade(request, { env: this.env });
    if (upgraded) {
      return upgraded;
    }
    return new Response("expected websocket", { status: 426 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Forward to the same hooks.message peer you use on the Worker, or keep
    // protocol handling inside the DO so hibernated sockets wake here.
    void ws;
    void message;
  }
}
```

The generated worker wrapper does not create a DO — hibernation is opt-in when you own the object.

`vite dev` and `rsbuild dev` serve the endpoint via middleware. `actions: "http"` (default) serves `/__oxide/action`; `actions: "ws"` uses a WebSocket instead (`crossws` on Node/`fetch`, `WebSocketPair` on `preset: "worker"`). `actions.sameOrigin` defaults to `true` for both transports; set it to `false` only when you intentionally accept cross-origin requests. Set `actions.path` to move the endpoint. `actionHeaders` are static headers on the shared HTTP client and are ignored for WebSocket actions.

## Rsbuild

```ts
// rsbuild.config.ts
import { defineConfig } from "@rsbuild/core";
import oxide from "oxidejs/rsbuild";

export default defineConfig({
  plugins: [oxide()],
});
```

Same factory as Vite: client stubs, `/__oxide/action`, and `dist/server.js`.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `preset` | `"fetch"` | `"fetch"` or `"worker"` |
| `workerEntry` | `src/server.ts` | Relative to project root. Default path is skipped when missing (actions-only). Explicit path must exist. |
| `outDir` | `dist` | Output root |
| `clientDir` | `client` | Must stay inside `outDir` |
| `wrangler.name` | required if `emitConfig` |  |
| `wrangler.compatibility_date` | required if `emitConfig` |  |
| `wrangler.compatibility_flags` | — | optional (not auto-merged; celld ignores `nodejs_compat`) |
| `wrangler.account_id` | — | optional; Cloudflare wrangler deploy only (breaks `celld deploy`) |
| `wrangler.workers_dev` | — | optional; Cloudflare `*.workers.dev` |
| `wrangler.routes` | — | optional; Cloudflare route patterns |
| `wrangler.d1_databases` | — | optional |
| `wrangler.durable_objects` | — | optional |
| `wrangler.migrations` | — | optional |
| `wrangler.kv_namespaces` | — | optional |
| `wrangler.r2_buckets` | — | optional |
| `wrangler.services` | — | optional |
| `wrangler.vars` | — | optional |
| `wrangler.workflows` | — | optional; merged with scanned `workflow()` exports in `*.server.ts` |
| `wrangler.queues` | — | optional; merged with scanned `queue()` exports in `*.server.ts` |
| `wrangler.triggers` | — | optional; `crons` merged with scanned `schedule()` exports |
| `emitConfig` | `true` on `worker` | Set `false` to skip `wrangler.jsonc` |
| `actions` | `"http"` | `"ws"` uses WebSocket (`crossws` on Node, `WebSocketPair` on worker); object form: `{ transport, path, sameOrigin }` (`sameOrigin: true`) |
| `actionHeaders` | — | Static headers on the HTTP client |
| `middleware` | `[]` | Fetch middleware, run in order before WS upgrade, actions, and the server entry |
| `imports` | `[]` | Modules imported for side effects at server startup |
| `bodyLimit` | `1048576` | Max Node request body size; larger requests get 413 |
| `notFound` | — | Custom HTML 404 body when no route or asset matches |
| `env` | — | Node preset value passed to `fetch(request, env, ctx)` |

### `middleware` and `imports`

```ts
oxide({
  middleware: ["@ilha/router/ssr"], // string or { module, imports }
  imports: ["./side-effects"],
});
```

Middleware modules receive `(request, { env, ctx })`. They run before actions, the server entry, and assets. Return a `Response` to stop the chain or `undefined` to continue. Vite loads the same modules through its SSR graph in development. Middleware entries may carry their own `imports`.

`main` is always `./server.js`. `assets` is added only when `index.html` exists. Unknown wrangler keys fail at build time.

## Non-goals

- No `wrangler dev` / workerd emulation
- No automatic `celld deploy`
- No Node-builtin polyfills — Vite `ssr.noExternal: true` is a hard-fail for stray Node imports

## Security

### Asset serving (`preset: "fetch"`)

The generated server serves static files from `dist/client/` (or the `public/` directory merged into it). These guards are active:

| Attack vector | Guard |
| --- | --- |
| **Traversal** (`%2e%2e/`, `..%2f`) | `__rel()` rejects paths containing `..` segments. |
| **Double-slash** (`///etc/passwd`) | `__rel()` rejects results that still start with `/` after `slice(1)`. |
| **Null byte** (`%00`, `\0`) | `__rel()` rejects paths containing null bytes before and after `decodeURIComponent`. |
| **Absolute path** (`/etc/passwd`) | `__rel()` returns `null` for paths not starting with `/`. |
| **SPA fallback** | Unknown paths → `index.html`, never a directory listing. |
| **`clientDir` escape** | `resolveOptions` throws at build time if `clientDir` resolves outside `outDir`. |
| **Hashed assets** | Files matching `[-.][0-9a-f]{8,}.ext` get `Cache-Control: public, max-age=31536000, immutable`. Other files are not cached by default. |

The generated `__asset` function uses `path.join` — not `path.resolve` — so a leading `/` in the relative path stays inside the asset root.

### Server actions (`*.server.{ts,tsx,js,jsx}`)

- Server action code is **never bundled into the client**. Client imports are replaced with Effect RPC stubs that POST the action endpoint (default `/__oxide/action`). The original source stays server-only.
- Only `action()`-wrapped exports are exposed as RPC; other exports stay server-local.
- Stream actions use newline-delimited JSON-RPC (`application/json-rpc`) over that same endpoint — not Server-Sent Events. Frames are scrubbed as they flush on HTTP and WebSocket.
- The endpoint is POST-only. Non-POST requests return `405`.
- Method dispatch uses `Object.hasOwn`, blocking `__proto__` / `constructor` walks.
- Unknown or missing content-types → `415`.
- Body size capped at 1 MB by default (enforced on the actual body, not just `Content-Length`).
- Batch requests capped at 20 items (both HTTP and WebSocket transports).
- Effect `Defect` / `Cause` payloads are scrubbed before they leave the endpoint. Clients see plain JSON-RPC errors (`code` + `message` only). Thrown messages become `Internal error` (`-32603`). Unknown methods → `-32601`; invalid params → `-32602`.
- `actions.sameOrigin` defaults to `true`. Requests without both `Origin` and `Sec-Fetch-Site` are rejected when that check is on.
- StackBlitz WebContainers do not keep `AsyncLocalStorage` across `async/await`. Oxide detects `process.versions.webcontainer` and falls back to a sync request store, capturing context before Effect schedules work and serializing handler entry so concurrent requests do not stomp that store. Stream pulls re-enter the captured store. This is a demo/dev workaround, not a concurrency model for production.

### Host header

The generated dev server constructs `request.url` from `req.headers.host`. This is standard HTTP/1.1 behavior (same as Express, Hono, Koa, Node http). If your `src/server.ts` reads `request.url` to construct redirects, validate the host yourself — the framework cannot distinguish a legitimate host header from a malicious one. In production, your reverse proxy handles this.
