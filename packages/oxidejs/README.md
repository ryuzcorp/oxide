# oxidejs

One build command → a deployable tree:

```
dist/
├── client/           # only if index.html exists
└── server.js         # ESM server bundle
```

For Cloudflare Workers, add a root `wrangler.jsonc` (preset defaults to `"worker"`) and `@cloudflare/vite-plugin` — oxide supplies `virtual:oxide/worker` and durable bindings; Cloudflare owns the Worker build and deploy. Override with `preset: "fetch"` or `preset: "worker"` when needed.

v1 targets **Vite** and **Rsbuild** via unplugin. Other bundlers are out of scope for now.

The `oxidejs` entry exports runtime helpers (`action`, `useRequest`, …). The bundler plugin lives at `oxidejs/vite` or `oxidejs/rsbuild` — keep those separate so `*.server.ts` can import `oxidejs` under `preset: "worker"` without pulling Node build tooling into the worker graph.

## Vite

```ts
import oxide from "oxidejs/vite";
// vite.config.ts
import { defineConfig } from "vite";

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

Default is Node when no wrangler config is present. No `index.html` → only `dist/server.js`. With `index.html` → client to `dist/client/`, then `/__oxide/action` (if you have a `*.server.{ts,tsx,js,jsx}` file) → `src/server.ts` when present (`undefined` continues) → static file → `index.html` for navigations. Missing the default `src/server.ts` is fine — actions and static assets still run. `vite dev` and `rsbuild dev` run the same `src/server.ts` fetch — return `undefined` to fall through to dev static/SPA handling. `public/` is copied next to the client. Hashed assets get `Cache-Control: immutable`.

Workers apps add a root `wrangler.jsonc` (preset defaults to `"worker"`) and `@cloudflare/vite-plugin` — oxide stays companion-only:

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import oxide from "oxidejs/vite";
import { withOxide } from "oxidejs/wrangler";

export default defineConfig({
  plugins: [oxide({ actions: "ws", middleware: [] }), cloudflare(withOxide())],
});
```

Point root `wrangler.jsonc` `main` at a thin entry that re-exports `virtual:oxide/worker`. `preset: "worker"` uses the Worker wrapper (ASSETS, workflow class exports, `WebSocketPair`) and leaves Vite Worker environments to Cloudflare's plugin. Put name, compat, D1/R2/vars in the root wrangler file. Override with `preset: "fetch"` or `preset: "worker"` when auto-detect is wrong.

You can use a root `cloudflare.config.ts` (the `cf` CLI config) instead of a wrangler file. Install `@cloudflare/config` (and `cf` for the `cf/config` import). The preset defaults to `"worker"`, `oxide()` loads and converts the file, and `withOxide()` hands the result to Cloudflare's plugin — no wrangler file. A root wrangler file or a `configPath` option wins over `cloudflare.config.ts`. Loading needs Node ≥ 22.18 (not Bun), and editing `cloudflare.config.ts` needs a dev server restart. `cf deploy` forces the plugin's `experimental.newConfig` flow, where any `config` customizer is rejected: `withOxide()` then contributes only environment naming, so declare scanned durable bindings in the config file itself with `oxideDurable` from `oxidejs/cf` (spread its `env` / `exports` / `triggers` into `defineWorker`) — otherwise workflows, queue producers/consumers, and crons never reach the deploy.

## Server actions

Files named `*.server.ts`, `*.server.tsx`, `*.server.js`, or `*.server.jsx` are server-only. A client import is replaced with an Effect RPC stub that POSTs `/__oxide/action` as newline-delimited JSON-RPC (`application/json-rpc`). The original module never enters the client graph. **Only exports wrapped in `action()` become remote actions** — any other export stays server-local and is not callable over the wire. Server and Vite SSR (`import.meta.env.SSR === true`) keep the real functions. Methods are `<file>.<fn>` (`test.ping`). Call `useRequest()` inside an action for the inbound `Request`. `useCtx()` is the request context (`{ req }` plus anything middleware stamped via `stampRequestContext`, or `createContext` added). On `preset: "worker"`, `useEnv()` and `useFetchCtx()` are the Worker `env` and `ctx` from `fetch(request, env, ctx)` — same values as `useCtx().env` / `useCtx().fetchCtx`. WebSocket upgrades run first (middleware Responses short-circuit, including auth `302`/`401`; only `@ilha/router/ssr` document Responses are ignored so celld does not see `has_target=false`). Other requests run middleware before the action gate. Return `undefined` from `src/server.ts` to fall through to static files. No server action files → the bundle does not import `oxidejs/rpc`. `action()` results are JSON-RPC data — returning a `Response` from an action is an error; return a raw `Response` from `src/server.ts` for raw HTTP responses.

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

`batch()` sends calls made in the same tick as one JSON-RPC 2.0 batch (single POST, one round trip). Items are pending calls, thunks that start one, or bare zero-arg handles; results resolve in call order and a failing call rejects the promise:

```ts
import { batch } from "oxidejs";

import { ping, task } from "./tasks.server";

const [pong, first] = await batch(ping, task("a"));
const [alsoPong, alsoFirst] = await batch([ping, () => task("a")]);
```

Per-call `{ idempotencyKey }` rides as a JSON-RPC frame header; an aborted `{ signal }` call is dropped from the batch. HTTP only (with `transport: "ws"` each call still sends its own message), streams cannot be batched, and on the server/SSR the same calls run locally in parallel.

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

The client arg is the schema's Encoded type; the handler receives Type, and an awaiting caller sees only that data — not an Effect union. Calling the `withSchema` function directly with an invalid payload throws `SchemaDecodeError` before the handler runs; through `action()` that is a rejected promise. Over RPC a decode failure is JSON-RPC Invalid params (`-32602`). Optional `success` / `error` schemas stamp the generated Rpc tag; declare a `Schema.TaggedError` `error` for a wire-typed Fail (`-32000` after scrub), or `fail(message)` (throws `ActionFailure`) for a user-facing message.

Declare the payload once: `action(withSchema(schema, fn), { payload })` throws at definition, because RPC would decode it twice.

Where the schemas live decides what the client gets. Import them from a plain module (not `*.server.*`) and the generated client Rpc group uses them: it validates the Encoded payload before sending (an invalid shape rejects with `SchemaDecodeError`, `-32602`, without a request), decodes the response with `success` so the client sees the handler's Type (a `Schema.Date` success arrives as a `Date`), and rejects a declared tagged `error` as an instance of that class — `instanceof NotFound`, real fields, `code: -32000`. Putting the schemas in a shared module keeps the client bundle free of the server module; nothing reachable only through a `*.server.ts` file is ever imported by the client. The group builds that error codec with `clientErrorSchema(schema)` (exported for codegen), which unwraps the JSON-RPC error envelope — you rarely call it yourself.

Declare a schema inline, locally, or in another `*.server.ts` file and it stays server-only: the client keeps `Schema.Unknown` for that slot, so it sends whatever you pass, a `success` schema does not decode, and a declared error arrives as an `ActionError` (still with `_tag`, `code` and the decoded fields):

```ts
// src/tasks/shared.ts — plain module, safe for the client
import { Schema } from "effect";

export const AddTask = Schema.Struct({ text: Schema.String });
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  id: Schema.String,
}) {}
```

```ts
// src/tasks.server.ts
import { action, withSchema } from "oxidejs";

import { AddTask, NotFound } from "./tasks/shared";

export const add = action(
  withSchema(AddTask, async ({ text }) => ({ id: "1", text })),
  { error: NotFound }
);
```

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

Use `liveQuery` / `publish` for snapshot streams (query = subscription, mutation = publish). Hubs are isolate-local Effect PubSub — a publish reaches subscribers in the same isolate only, not other Worker isolates or celld nodes — and D1 (or your DB) stays the source of truth. Mutations on one topic run one at a time; one waits at most `mutateWaitMs` (default 10000) for the previous, and a mutation overtaken during that wait does not publish its older snapshot. `close()` shuts a topic's hub down; a mutation that finishes after it fails with `LiveQueryClosedError`. Prefer Effect `Stream` + `mutateEffect`:

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

### Workflows (`preset: "worker"`)

Durable multi-step jobs on Cloudflare Workflows / celld. Export `workflow()` from a `*.server.ts` file — oxide emits the `WorkflowEntrypoint` class, merges bindings via `mergeDurableBindings`, and exposes `start` / `status` / `send` over the same action RPC.

```ts
// src/invoice.server.ts
import { Schema } from "effect";
import { workflow } from "oxidejs";

const Params = Schema.Struct({ orderId: Schema.String });

export const invoice = workflow({
  name: "invoice",
  payload: Params,
  run: async ({ payload }, { step }) => {
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

Defaults: binding `INVOICE`, class `InvoiceWorkflow`. Override with `binding` / `className` (string literals — the build scanner does not evaluate variables). Pass `{ idempotencyKey }` on `start` for a stable instance id. Retries with the same id reuse the existing instance (`create` is not idempotent on Cloudflare; oxide falls back to `get`). Keep side effects inside `step.do` — the runtime replays `run()` from the start. The second `run` argument is `{ step, env }` (plus optional `signal` later); oxide also stamps a request store so `useEnv()` / `useCtx()` work inside `run`. Requires `preset: "worker"`. Do not use the same workflow `name` as a `*.server.ts` module key that also exports `action()`s. `status` returns `{ status: "not_found" }` when the instance does not exist yet (e.g. right after a queue `send`, before the consumer creates it) instead of an Internal error. A Vercel / fetch driver is not wired yet.

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
  run: async ({ payload }, { step }) => {
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

Oxide merges `queues.producers` / `queues.consumers` via `mergeDurableBindings` and attaches a same-worker `queue` handler that starts the workflow from each message (via `createBatch` when available, otherwise duplicate-aware `create`/`get`). Cloudflare does not return message ids from `send`, so oxide wraps bodies in an envelope with a client-chosen id (`{ idempotencyKey }` / request header / UUID) and returns `{ id }` from `send` (and `{ ids }` from `sendBatch`) for `workflow.status` polling. Queue transport options (`contentType` / `delaySeconds`) travel in the RPC payload; `signal` / `idempotencyKey` stay on `CallOptions`. Every message gets its own id: with a key, the first send in a request uses it and later sends (and each message of a `sendBatch`) use `key-1`, `key-2`, … (valid Workflows instance ids, trimmed to 100 chars), so a retried request reproduces the same ids. The consumer acks the messages it started and retries only the ones that failed. Queue consumers and cron handlers run inside a request store, so `useEnv()`, `queue.send()` and `workflow.start()` work there.

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
  run: async ({ payload }, { step }) => {
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

Exactly one of `workflow` / `queue` / `handle`. Oxide merges unique cron expressions into wrangler `triggers.crons` via `mergeDurableBindings` and attaches a same-worker `scheduled` handler. Each tick starts the workflow with id `` `${name}-${scheduledTime}` `` (letters/digits/`-`/`_` only — celld and Cloudflare reject `:`). `params` may be a value or `(event) => value`; payload schema comes from the workflow/queue handle.

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

Pass `storage` to keep a failed write across a reload. `indexedDbStorage()` is a browser adapter with no dependencies; implement `load` / `put` / `delete` for anything else:

```ts
import { createMutationQueue, indexedDbStorage } from "oxidejs/mutation-queue";

import { add } from "./tasks.server";

const queue = createMutationQueue({ storage: indexedDbStorage() });
const addQueued = queue.wrap(add, {
  key: "tasks.add", // "<file>.<fn>": how a restored write finds its action
  idempotencyKey: (text) => `add:${text}`,
});

await queue.ready; // persisted writes are loaded (and replaying)
```

With storage, `wrap` needs `key`, and args must survive `structuredClone`; a call that cannot be persisted rejects at enqueue with a clear error. Restored writes replay in FIFO order once their action is wrapped, keeping the same `idempotencyKey` so server-side dedupe still applies. Nothing awaits a restored write, so its outcome arrives as an event: `restore`, `success`, or `discard` (removed after a permanent failure). Built with `indexedDbStorage()` the adapter throws where IndexedDB is missing (SSR/Node); a store that is present but unwritable (private mode) emits `error` and the queue keeps working in memory. `storage: "memory"` (the default) changes nothing.

`wrap` forwards the queue id as trailing `{ idempotencyKey }`. That key is sent as RPC header `x-oxide-idempotency-key` and available as `useIdempotencyKey()` on the server.

For durable dedupe, claim the key with one statement that reports whether it inserted. Do not use paranorm `once()` on D1: it claims with `INSERT OR IGNORE` and then reads `SELECT changes()` in a follow-up statement, but D1 runs each statement in its own implicit transaction and does not carry `changes()` across them — the follow-up reports 0, so `once()` takes every call for a duplicate and the write never runs. Use `INSERT … ON CONFLICT DO NOTHING RETURNING`, which returns no row when the key already exists:

```ts
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/sql/SqlClient";
import { action, useIdempotencyKey } from "oxidejs";

const claim = (key: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ key: string }>`
      INSERT INTO paranorm_idempotency (key) VALUES (${key})
      ON CONFLICT DO NOTHING
      RETURNING key
    `;
    return rows.length > 0;
  });

export const add = action((text: string) =>
  Effect.gen(function* () {
    const key = useIdempotencyKey();
    if (key && !(yield* claim(key))) {
      return; // duplicate replay — the first call already wrote
    }
    // ...write `text`
  })
);
```

`paranorm_idempotency` is the `key TEXT PRIMARY KEY` table paranorm's `_extends: [idempotency]` creates; any equivalent table works. Run `claim` against the same `SqlClient` as the write (the kit wraps both in `withDb`).

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

`vite dev` and `rsbuild dev` serve the endpoint via middleware. `actions: "http"` (default) serves `/__oxide/action`; `actions: "ws"` uses a WebSocket instead (`crossws` on Node/`fetch`, `WebSocketPair` on `preset: "worker"`). `actions.sameOrigin` defaults to `true` for both transports; set it to `false` only when you intentionally accept cross-origin requests. Set `actions.path` to move the endpoint. Set `actions.openrpc: true` to serve `GET /__oxide/openrpc` — an [OpenRPC](https://spec.open-rpc.org/) 1.3 document for `action()` handlers only (Effect Schema → JSON Schema; workflows/queues/schedules are omitted). OpenRPC is HTTP-only and stays off when `transport` is `"ws"`. `actionHeaders` are static headers on the shared HTTP client and are ignored for WebSocket actions. Set `actions.timeout` (milliseconds) to bound every action: an action that has not answered in time is interrupted, and the client gets a JSON-RPC `-32603` error instead of a request that never ends. Each call of a batch has its own deadline, and a batch answers each call as soon as it ends. A stream counts as answered at its first frame. The generated client gives up 5 s after the server deadline. `bodyLimit` also bounds action request bodies on the worker preset (HTTP 413).

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
| `preset` | auto | `"worker"` when `wrangler.jsonc` / `.toml` / `.json` or `cloudflare.config.ts` exists, else `"fetch"`. Override explicitly. |
| `workerEntry` | `src/server.ts` | Relative to project root. Default path is skipped when missing (actions-only). Explicit path must exist. |
| `outDir` | `dist` | Output root (Node / `"fetch"`) |
| `clientDir` | `client` | Must stay inside `outDir` |
| `actions` | `"http"` | `"ws"` uses WebSocket (`crossws` on Node, `WebSocketPair` with `"worker"`); object form: `{ transport, path, sameOrigin, openrpc, timeout }` (`sameOrigin: true`, `openrpc: false`, no `timeout`) |
| `actionHeaders` | — | Static headers on the HTTP client |
| `middleware` | `[]` | Fetch middleware. On WS: honor Responses (auth 302/401/…); ignore only `@ilha/router/ssr` document Responses. Otherwise Response short-circuits before actions / server entry. |
| `plugins` | `[]` | Build plugins (`beforeBuild` / `afterBuild`). Pass objects or module IDs. |
| `imports` | `[]` | Modules imported for side effects at server startup |
| `bodyLimit` | `1048576` | Max Node request body size; larger requests get 413 |
| `notFound` | — | Custom HTML 404 body when no route or asset matches |
| `env` | — | Node value passed to `fetch(request, env, ctx)` |

Durable bindings (`workflow` / `queue` / `schedule`) merge via `withOxide` (or `mergeDurableBindings`) from `oxidejs/wrangler` into your Cloudflare plugin options — not via oxide options.

`writeCelldWrangler(path)` / `toCelldWrangler(config)` strip Cloudflare Vite snapshot keys that `celld deploy` rejects (`workers_dev`, `dev`, `jsx_*`, `no_bundle`, …). Dropping `no_bundle` matters: the Vite Worker graph is multi-chunk, and celld only stubs `node:*` / `cloudflare:*` — relative `./assets/…` imports fail at load unless celld runs esbuild.

For the Cloudflare Vite layout (`dist/ssr` + `dist/client`), production builds automatically run `prepareCelldDeploy` when `dist/ssr/wrangler.json` exists — writing `dist/wrangler.json` with relocated paths (`main: "celld/entry.js"`, `assets.directory: "client"`), removing Cloudflare-only asset files celld rejects (`.assetsignore`), stripping bare unused `import "node:fs"` / `import "node:path"` side-effects into `dist/celld/entry.js` (outside `ssr/`, so Cloudflare deploy does not upload a second Worker module), and merging project `.dev.vars` into `vars` (celld does not load `.dev.vars` like `wrangler dev`). Keep the allowlist aligned with celld's `SUPPORTED_KEYS`. Call `prepareCelldDeploy("dist")` yourself only if you need the rewrite outside a normal oxide build. Cloudflare `wrangler deploy` still uses the Vite SSR snapshot; the extra `dist/wrangler.json` / `dist/celld/` are for celld.

### `plugins`

```ts
oxide({
  plugins: ["./build-plugin.ts"],
});
```

Each plugin may define `beforeBuild` and/or `afterBuild` `(ctx) => void | Promise<void>` where `ctx` is `{ root, outDir, preset }`. Hooks run once per production build (not during `vite` / `vite dev`). Specifiers are dynamic-imported (relative paths against the project root) and must default-export an `OxidePlugin`.

### `middleware` and `imports`

```ts
oxide({
  middleware: ["@ilha/router/ssr"], // string or { module, imports }
  imports: ["./side-effects"],
});
```

Middleware modules receive `(request, { env, ctx })`. On WebSocket upgrades, any middleware `Response` short-circuits except `@ilha/router/ssr` (document HTML has no `webSocket` target for celld). On other requests, return a `Response` to stop the chain or `undefined` to continue. Vite loads the same modules through its SSR graph in development. Middleware entries may carry their own `imports`.

## Non-goals

- No oxide-owned `wrangler` / workerd emulation (use `@cloudflare/vite-plugin`)
- No automatic `celld deploy` / `wrangler deploy`
- No Node-builtin polyfills — Vite `ssr.noExternal: true` is a hard-fail for stray Node imports

## Security

### Asset serving (Node)

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
- Effect `Defect` / `Cause` payloads are scrubbed before they leave the endpoint. A rejected client call is an `Error` instance: `ActionError` carrying the JSON-RPC `code`, the server error's `_tag` and its decoded fields; `SchemaDecodeError` for invalid params (`-32602`); or `ActionFailure` for `fail(message)`. A plain thrown `Error` is still masked as `Internal error` (`-32603`) — call `fail(message)` or declare a tagged `error` to surface a message. Unknown methods → `-32601`; invalid params → `-32602`.
- Every action call runs in its own Effect RPC runtime, disposed when its response ends. A shared runtime would let a concurrent action read another request's context, and on Worker hosts (Cloudflare Workers, celld) it stalls, because the host drops a finished request's pending work.
- Worker code must not share a promise, timer or runtime across requests unless it is registered with `waitUntil` or its waiters are time-bounded: on celld, work a request started stops when that request answers or its client goes away. `bun run smoke:celld` checks the action server against a real celld node.
- `actions.sameOrigin` defaults to `true`. HTTP actions require `Origin` and/or `Sec-Fetch-Site` and reject cross-site callers. WebSocket upgrades additionally allow requests that omit both headers when `Host` matches the request URL host (celld and some proxies strip those headers; `localhost` / `127.0.0.1` / `::1` count as the same host).
- StackBlitz WebContainers do not keep `AsyncLocalStorage` across `async/await`. Oxide detects `process.versions.webcontainer` and falls back to a sync request store, capturing context before Effect schedules work and serializing handler entry so concurrent requests do not stomp that store. Stream pulls re-enter the captured store. This is a demo/dev workaround, not a concurrency model for production.

### Isolate-level setup

Setup you start inside a request — a migration, a cache warm — cannot rely on the request that started it. celld (and Cloudflare Workers) drop a finished request's pending work, so a pass started by a request that ends is orphaned; a `WeakMap` promise cache around it then hangs every later request, and a failed pass latches its rejection for the isolate's life.

Run that setup through `isolateOnce`:

```ts
import { isolateOnce } from "oxidejs";

const migrate = isolateOnce(
  async (db: D1Database) => {
    await db.exec("create table if not exists tasks (id text primary key)");
  },
  { timeout: 15_000, wait: 5000 }
);

export const ensureDb = (db: D1Database) => migrate(db);
```

Concurrent callers share one in-flight pass. The pass is bounded by `timeout` (default 30 000 ms): a pass that has not settled fails and clears, so the next caller retries. A caller that has waited `wait` ms (default 5000 ms) on a pass another request started runs its own pass instead, so an orphaned pass cannot hang the isolate. That pass can overlap one that is still alive but slow, so `fn` must be idempotent and safe to run concurrently (e.g. migrations that record what they applied). A successful pass stays cached for the isolate's life.

Key the pass by a binding object to keep one pass per binding (`WeakMap`-backed, so the cache does not leak); omit the key for one pass per isolate. `isolateOnceEffect` returns the Effect-shaped runner.

`run.reset(key?)` forgets the cached pass for that key (or the unkeyed slot), so the next call runs `fn` again — for example after a schema change in dev, or between tests. Callers already awaiting an in-flight pass still get its result.

### Host header

The generated dev server constructs `request.url` from `req.headers.host`. This is standard HTTP/1.1 behavior (same as Express, Hono, Koa, Node http). If your `src/server.ts` reads `request.url` to construct redirects, validate the host yourself — the framework cannot distinguish a legitimate host header from a malicious one. In production, your reverse proxy handles this.
