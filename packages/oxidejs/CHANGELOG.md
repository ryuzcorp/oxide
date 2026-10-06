# Changelog

## 0.6.0

### Added

- `isolateOnce(fn, { timeout, wait })` / `isolateOnceEffect`: once-per-isolate async setup that is safe on celld and Workers. Concurrent callers share one pass, bounded by `timeout` (default 30 s). A failure or timeout clears the pass, so the next caller retries. A caller that has waited `wait` ms (default 5 s) on a pass started by another request runs its own, so a pass orphaned when its request ended cannot hang the isolate. That pass can overlap a slow live one, so `fn` must be idempotent and safe to run concurrently. Success is cached for the isolate. An optional object key (e.g. a D1 binding) keeps one pass per key.
- `isolateOnce` / `isolateOnceEffect` runners have `reset(key?)`: forget the cached pass so the next call runs `fn` again (in-flight callers keep their pass). New exported types `IsolateOnceRunner` / `IsolateOnceEffectRunner`.
- `ActionError`: client action calls reject with an `Error` carrying the JSON-RPC `code`, the server error's `_tag` and its decoded fields. Fields are copied as own properties, so a `__proto__` key in wire data cannot change the error's prototype.
- `ActionFailure` + `fail(message)`: throw `fail("…")` in an action to send a user-facing message. Every generated action error schema includes `ActionFailure`, so no `error` option is needed.
- `toActionError(error, declared?)`: turns a raw RPC rejection envelope into the matching Oxide error class; with a declared tagged error schema it decodes `data` into that class.
- Client schemas: the generated client RpcGroup now uses an action's real `payload` / `success` / `error` schemas when the `*.server.ts` file imports them from a shared (non-`.server`) module. Codegen resolves them statically (named imports and `import * as ns`), so the client never imports server code. Inline or locally declared schemas stay server-only (`Schema.Unknown` on the client, as before).
  - Payload: the client validates the schema's Encoded side before sending, so an invalid argument rejects with `SchemaDecodeError` (`-32602`) and no request goes out.
  - Success: the wire value decodes back to the handler's Type, so a `Schema.Date` result arrives as a `Date` (streams decode each chunk).
  - Error: a declared `Schema.TaggedError` rejects as an instance of that class (`instanceof NotFound`, real fields, `code: -32000`). `clientErrorSchema(declared?)` is the client error codec codegen uses.
- Durable mutation queue (`oxidejs/mutation-queue`): `createMutationQueue({ storage })` takes a `MutationQueueStorage` adapter (`load` / `put` / `delete`), and `indexedDbStorage(name?)` is a dependency-free IndexedDB adapter (throws at construction when IndexedDB is missing, e.g. SSR). Queued writes then survive a reload, tab close or crash.
  - `wrap(fn, { key })` names the action (`"<file>.<fn>"`) so a restored write finds it again; required when `storage` is set.
  - Restored writes replay in FIFO order ahead of new ones, keep their original `idempotencyKey` (server dedupe still applies), and report through `subscribe` with new `restore` / `discard` events. `queue.ready` resolves once persisted writes have loaded; `flush()` waits for it.
  - With `storage`, non-cloneable args or a missing `key` reject at enqueue instead of losing the write. Without `storage`, behavior is unchanged.
  - New exported types `MutationQueueStorage`, `PersistedMutation`, `MutationOutcome`; `MutationQueueItem.key`.
- `bun run release` regenerates a template's standalone `bun.lock` whenever it changes that template's `oxidejs` range, so the kit Docker build's `bun install --frozen-lockfile` keeps working.

### Changed

- **Breaking (types):** `withSchema` returns `(payload: Encoded) => R` instead of `R | Effect.Effect<never, SchemaDecodeError>`, so an awaited action result is the handler's data. Calling the `withSchema` function directly with an invalid payload now throws `SchemaDecodeError` synchronously instead of returning `Effect.fail`; through `action()` it is a rejected promise. Over RPC it is still `-32602`.
- `action()` handles always return a promise: a handler that throws synchronously now rejects that promise instead of throwing at the call site.
- **Breaking:** `action(withSchema(schema, fn), { payload })` now throws when the action is defined. Declaring the payload twice made RPC decode it twice; use either `withSchema` or `{ payload }`.
- Client action rejections are `Error` instances (`ActionError`, `SchemaDecodeError` or `ActionFailure`) instead of plain `{ code, message }` objects. A plain thrown `Error` is still masked as `-32603 Internal error`.
- JSON-RPC error responses for a declared tagged `error` now include `error.data` (the encoded error), so the client can rebuild its tag and fields. This is an added field only.
- `SchemaDecodeError.from(...)` instances carry `code: -32602`.
- Kit template: `ensureDb` uses `isolateOnce` (15 s timeout, 5 s wait) instead of a `WeakMap` promise cache with no bound.
- Kit template celld setup now follows the production celld contract:
  - celld `0.4.1` → `0.6.1`; base image `oven/bun:1.3-debian` → `1.4-debian`.
  - Each node gets its own `CELLD_ASSET_CACHE_DIR` and a `CELLD_ASSET_CACHE_BYTES` bound.
  - `CELLD_TRUST_FORWARDED_HEADERS` is documented, off by default.
  - `CELLD_DEPLOY_POLL_S=300` is now only a fallback, since every deploy POSTs the node's internal `/reload` and goes live immediately.
  - `CELLD_DEPLOY_MAX_AGE_S=60` for `actions: "ws"`.
  - `CELLD_SHUTDOWN_TOTAL_MS=15000` stays under `stop_grace_period: 25s`.
  - `depends_on` conditions and a RustFS healthcheck mean a plain `docker compose up` works without `make up`.
  - Published ports (app `8080`, RustFS `9000` / `9001`) bind `127.0.0.1` only, matching the "localhost-only" note. Before this, they listened on every interface with the demo's default RustFS credentials.
- The kit template now needs oxidejs `0.6.0` (`isolateOnce`). It can't build against the registry `0.5.10`.
- Docs: paranorm `once()` is not safe on D1: its follow-up `SELECT changes()` runs as a separate query and always reads 0, so the write never runs. Use a single `INSERT … ON CONFLICT DO NOTHING RETURNING` instead.
- Docs: added the `vite build && celld dev dist` flow (source-mode `celld dev` cannot resolve `virtual:oxide/worker`) and an isolate-level setup section.

### Fixed

- Client action errors lost the server `_tag` and every decoded error field, and `String(error)` rendered `[object Object]`.
- `withSchema` with a transforming schema (e.g. `Schema.FiniteFromString`) answered `-32603 Internal error` to valid payloads over RPC, because the payload was decoded twice. RPC now decodes once.
- Kit template: a migration pass orphaned by an ended request hung every later request, and a failed migration stayed failed for the isolate's lifetime.

## 0.5.10

### Changed

- Simplified RPC defect scrubbing for `SchemaDecodeError` params (`extractParamsDieMessage` now scans the Die tree directly); internal, no behavior change

## 0.5.9

### Changed

- Bumped `effect` to `4.0.0` stable (and `@effect/sql-d1` to `4.0.0` in the kit template), `unplugin` to `^3.4.0`, and `@cloudflare/config` to `^0.22.0`

## 0.5.8

### Added

- Worker preset treats a root `cloudflare.config.ts` (`@cloudflare/config`, optional peer) as a worker project: when no wrangler file is present, `oxide()` loads it with `loadAndParseConfig` and converts it to the wrangler shape `withOxide` picks up

## 0.5.7

### Changed

- Bumped `effect` to `4.0.0-rc.118` (and `@effect/sql-d1` to `4.0.0-rc.118` in the kit template)
- `effect/unstable/*` imports moved to the stable subpaths (`effect/rpc`, `effect/http`, `effect/socket`, `effect/reactivity`, `effect/sql`); the kit template's `FindMyWay` / `SqlClient` imports moved with them
- The client stub declares `error: Schema.Unknown` on its Rpcs: rc.118 parses JSON-RPC error responses as `Fail` (was `Die`), so a `Never` error schema rejects every failed call with a schema decode error instead of the action's error
- `Socket.layerWebSocket` no longer takes `closeCodeIsError`: every close now fails the reader with a `SocketError(SocketCloseError)` and the protocol's retry policy reconnects; 1000/1001/1006 stay transient via the existing close-code matcher

## 0.5.6

### Security

- Concurrent actions could read another request's context. The Effect RPC runtime was built once and cached, and its server fibers kept the request context of the request that started them, so under concurrency `useRequest()` / `useEnv()` / `getRequestStore()` inside an action could return a different request (its headers, cookies, env) — measured 29 of 30 concurrent requests on Bun. Every action call now runs in its own runtime on every host

### Added

- `actions.timeout` (milliseconds): an action that has not answered in time is interrupted and answers with a JSON-RPC `-32603` error. Each call of a batch has its own deadline, so one slow call no longer fails the others. A stream counts as answered at its first frame. `createActionHandler` / `createWsHooks` take it as `timeoutMs`
- The generated client rejects a call 5 s after the server deadline (`actions.timeout`), for a hung network or proxy. `createClient` takes `timeout`, `retries` (default 2) and `maxReconnects` (default 8): an HTTP POST that failed in transit (network error, 502, 503, 504) is resent only when every call in it carries an `idempotencyKey`, and a WebSocket stream stops reconnecting after `maxReconnects`
- `createActionHandler({ maxBodyBytes })` refuses a larger body with HTTP 413; the worker preset passes `bodyLimit`, which before only applied to Node and dev
- `liveQuery({ mutateWaitMs })` (default 10000) and `liveQuery(...).close()`
- `bun run smoke:celld` (and a CI job) boots a celld node on the action server built from source and checks concurrency, request context, batch timeouts and recovery

### Changed

- A batch answers each call as soon as it ends instead of after the slowest one
- `disposeActionHandler` is a no-op: nothing is cached to dispose
- The sync request-store fallback (a module-global slot) is used on WebContainer only. Workers and celld keep the store in AsyncLocalStorage across `await`; the slot could hand one request's context to a concurrent one
- A queue consumer retries only the messages whose workflow failed to start and acks the rest, instead of retrying the whole batch
- Failed producer-side workflow starts (`producerStart`) are logged instead of swallowed

### Fixed

- celld: concurrent actions hung forever and then wedged the isolate until restart. celld's `node:process` answers every unknown `versions` key with a stub function, so `process.versions.webcontainer` read as truthy and every action queued behind one cross-request gate; a request the host cancelled never released it. WebContainer detection now requires a version string
- Worker hosts (Cloudflare Workers, celld) stalled on the cached runtime: the host drops a finished request's pending work
- `withRequestEntry` no longer chains Worker requests behind each other; only WebContainer serializes entry
- Two `queue.send()` calls, a `sendBatch()`, or a `workflow.start()` in one action with an idempotency key all reused that key as their id, so every message after the first was taken for the first and its workflow never started. Ids are now `key`, `key-1`, `key-2`, … per call (stable across retries of the same RPC call), valid Workflows instance ids trimmed to 100 chars
- Queue consumers and cron handlers run inside a request store, like workflow `run()`: `useEnv()`, `queue.send()` and `workflow.start()` no longer throw `request context is unavailable` there
- A `liveQuery` mutation waits at most `mutateWaitMs` for the previous one on its topic; a mutation whose request the host dropped no longer blocks the topic for good. A mutation that a newer one overtook during that wait does not publish its older snapshot, and a mutation that finishes after `close()` fails with `LiveQueryClosedError` instead of reporting success

## 0.5.5

### Added

- `batch()` batches action calls into one JSON-RPC 2.0 request: `batch(one("a"), two)` / `batch([one("a"), two])` post a single array body to `/__oxide/action` and resolve results in call order. Stream actions, the `ws` transport, and per-call `{ signal }` / `{ idempotencyKey }` are unchanged

## 0.5.3

### Added

- `actions: { openrpc: true }` serves `GET /__oxide/openrpc` — OpenRPC 1.3 document for `action()` handlers (Effect Schema → JSON Schema; workflows/queues/schedules omitted)

### Changed

- Production builds with a Cloudflare Vite `dist/ssr/wrangler.json` snapshot always run `prepareCelldDeploy` (removed `oxidejs/plugins/celld` and the earlier `OXIDE_CELLD=1` gate)
- `prepareCelldDeploy` writes the stripped Worker entry to `dist/celld/entry.js` (not beside Cloudflare's `ssr/` main) so `wrangler deploy` does not upload a second module
- Celld prepare also runs when the Vite `ssr` / `server` environment closes, so it still sees the snapshot when `client` finishes first
- Dev OpenRPC 503 responses use a generic error string (no SSR load message leak)
- `codecToJsonSchema` no longer swallows `toJsonSchemaDocument` failures

### Fixed

- `rewriteRelativeModuleSpecifiers` rewrites minified `from "…"` imports that use `$` bindings (celld esbuild could not resolve `./assets/…` from `dist/celld/entry.js`)
- OpenRPC discovery runs after middleware (production wrapper + Vite Connect bridge) so auth can reject `GET /__oxide/openrpc`
- `actions.openrpc: true` is ignored when `transport` is `"ws"` (discovery is HTTP-only)
- OpenRPC `components.schemas` merge throws on conflicting definitions for the same name
- Relative celld entry rewrite skips import-shaped text inside strings and comments

### Breaking

- Removed the `oxidejs/plugins/celld` export — celld prepare is built into production builds when `dist/ssr/wrangler.json` exists; drop `plugins: ["oxidejs/plugins/celld"]` from your config

## 0.5.2

### Breaking

- `workflow({ run })` second argument is now a context bag: `run(event, { step, env?, signal? })` instead of a bare `step` (so action-style context can grow without another signature break)

## 0.5.1

### Fixed

- Schedule workflow instance ids use `${name}-${scheduledTime}` instead of `${name}:${scheduledTime}` — celld / Cloudflare reject `:` in instance ids
- Worker ASSETS SPA path rejects HTML `200` responses for non-document requests (Cloudflare Assets `single-page-application` was serving `index.html` as JS/CSS for stale hashed URLs)
- Worker ASSETS SPA path also treats celld's `307 → /` for missing HTML routes as not-found (celld does this even with `not_found_handling: "none"`), and fetches `/` for the shell (celld also redirects `/index.html` → `/`)
- WebSocket upgrades no longer fall through to Assets/SPA (celld logged `ws_json=null has_target=false` and clients reconnect-looped)
- WS `sameOrigin` allows upgrades that omit both `Origin` and `Sec-Fetch-Site` when `Host` matches (celld strips those headers), including localhost ↔ 127.0.0.1
- WS upgrade runs before the Response-returning middleware loop; middleware Responses (including auth `302`) short-circuit, except `@ilha/router/ssr` document Responses which are ignored so celld does not see `has_target=false`; also treats `Sec-WebSocket-Key` as an upgrade signal
- `ensureWorkerDom` never installs linkedom `Event` / `EventTarget`, even when the host global is missing at install time
- `prepareCelldDeploy` merges project `.dev.vars` into wrangler `vars` (celld does not load `.dev.vars` like `wrangler dev`); existing wrangler vars — including JSON values — win over the file

### Breaking

- Removed `wrangler` / `emitConfig` from `oxide()` — Workers apps use `preset: "worker"` with `@cloudflare/vite-plugin` and a root `wrangler.jsonc`
- Oxide no longer emits `dist/wrangler.jsonc` or owns the Vite Worker target
- Schedule tick instance id separator changed from `:` to `-` (`demo-hourly-…` not `demo-hourly:…`)
- `mergeDurableBindings(config)` mutates in place and returns `void` (do not return a partial config into Cloudflare's `defu` merge — that duplicates arrays)

### Changed

- `preset` defaults from the project root: wrangler config present → `"worker"`, otherwise `"fetch"` (overridable)

### Added

- `plugins` option — `beforeBuild` / `afterBuild` once per production build
- `oxidejs/wrangler` → `withOxide` HOF for `cloudflare(withOxide())` (defaults `viteEnvironment.name` to `"ssr"`, merges durable bindings; optional `root` when Vite root ≠ cwd), plus `mergeDurableBindings` for hand-rolled `config` customizers
- Relative `plugins` module IDs resolve against the project root
- `toCelldWrangler` / `writeCelldWrangler` — strip Cloudflare Vite wrangler snapshot keys that `celld deploy` rejects (including `no_bundle`, so celld esbuilds the multi-chunk Vite Worker into one module)
- `prepareCelldDeploy` — write `dist/wrangler.json` with in-project paths for Cloudflare Vite (`ssr/` + `client/`) layouts; strip `.assetsignore`; rewrite `main` to `celld/entry.js` without bare `node:fs` / `node:path` side-effect imports (celld 0.4 has no `node:fs` stub)

## 0.5.0

### Added

- `workflow()` + `*.server.ts` (worker): Cloudflare Workflows driver — class export, wrangler `workflows`, RPC `start` / `status` / `send` (no separate `*.workflow.ts`)
- `queue({ name, workflow })` + `*.server.ts` (worker): Cloudflare Queues — wrangler `queues` producers/consumers, same-worker `queue` handler starts the workflow per message, RPC `send` / `sendBatch` return client-chosen `{ id }` / `{ ids }` (CF does not expose message ids on send)
- `schedule({ name, cron, workflow })` + `*.server.ts` (worker): Cron triggers — wrangler `triggers.crons`, same-worker `scheduled` handler starts workflow (id `` `${name}-${scheduledTime}` ``) or `queue` / `handle`
- `liveQuery.mutateEffect` / `stream` / `subscribeStream` for Effect-native live queries
- `oxideRuntimeLayer()` — host Logger Layer for action spans / logs
- Mutation queue `retries` / `retryBase` — Effect `Schedule.exponential` backoff on `flush`
- Effect Stream actions re-enter the request store on every pull (same as async generators) so `Stream.unwrap` + `useDb()` work on Workers
- Worker wrangler emit accepts Cloudflare deploy keys: `account_id`, `workers_dev`, `routes`, `kv_namespaces`

### Fixed

- Workflow `start`, queue consumers, and schedule ticks are duplicate-aware: Cloudflare `create({ id })` conflicts fall back to `get`; queue batches prefer idempotent `createBatch`
- `Promise.withResolvers` replaced with a small deferred helper so Node 20 hosts still work (`engines.node` stays `>=20.11`)
- `oxidejs/worker-dom/install` is listed in `sideEffects` so Rsbuild/production DCE cannot drop the Worker DOM installer
- Queue `contentType` / `delaySeconds` are RPC payload args (separate from `CallOptions`); schema-backed `send` accepts an optional second options object
- Durable API scanners require string literals for `name` / `binding` / `className` / `cron` and reject object shorthand (`{ workflow }`) instead of mis-reading identifiers
- `runActionInContext` keeps the Worker / WebContainer sync request store for the whole Effect fiber. Wrapping Effect handlers in `withRequestStore` cleared `useDb()` / `useEnv()` before the fiber ran (kit live-query mutations published empty snapshots on celld).
- Workflows are scanned from `workflow()` exports in `*.server.ts` (no `*.workflow.ts`). Leftover `*.workflow.ts` files error at build with a migration hint.
- Worker WebSocket `send` no longer gates on `WebSocket.OPEN` (undefined on workerd/celld), which dropped every RPC reply and Effect `@effect/rpc/Pong` and closed the kit action socket
- `ensureWorkerDom` no longer overwrites host `EventTarget` / `Event` with linkedom — that broke WebSocketPair `message` delivery on celld so action Ping never got a Pong
- Worker `WebSocketPair` uses indexed `pair[0]` / `pair[1]` (celld's array-like `length` made `Object.values` return three entries)
- Workflow-backed `queue().send` / `sendBatch` accept optional `producerStart: true` to also start the workflow from the producer (same envelope id). Default is off so Cloudflare queue semantics control execution; opt in for celld (same-worker consumers do not run with `fetch()`). Create-after-enqueue failures are soft-failed. Skipped when `delaySeconds` is set.
- Queue workflow starts keep the Workflow binding as `this` (do not extract `.create` / `.get`) — celld threw `this._create is not a function` otherwise
- Schedule workflow ticks keep the Workflow binding as `this`; schedule→queue ticks inherit `producerStart` from the queue handle
- Workflow `status` returns a plain JSON status object (drops CF `error: null` / host proxies) and maps platform throws to `{ status: "unknown", error }` instead of Rpc Defects ("Internal error")
- Workflow `createBatch` falls back to idempotent per-id create when the batch create throws (e.g. duplicate ids)
- Worker WebSocket action Requests keep the upgrade URL scheme (`https` / `http`). Forcing `http://` broke Better Auth `__Secure-*` session cookies on `*.workers.dev`
- Worker wrangler emit sets `assets.run_worker_first: true` so Cloudflare invokes the Worker before static assets (SSR / actions / `/api/*`)
- Worker wrangler emit no longer force-merges `nodejs_compat` (optional; celld ignores it). Cloudflare-only keys (`account_id`, `workers_dev`, `routes`) still emit when set — omit them for `celld deploy`
- Durable API scanners read only top-level object props (brace-depth-aware) so nested `name` / `cron` / `queue` / `workflow` / `handle` do not override config

### Changed

- Renamed preset `"celld"` → `"worker"` (Cloudflare Workers). Breaking: `"celld"` is no longer accepted.
- `action()` Stream overload accepts Fail / Services channels (`Stream.Stream<Y, E, R>`)

## 0.4.1

### Added

- Optional default `workerEntry`: missing `src/server.ts` skips the user server module (actions / assets only)

### Changed

- Explicit `workerEntry` that does not exist fails at config resolve

## 0.4.0

### Added

- `action(fn, { payload?, success?, error?, stream? })` stamps Effect Rpc schemas for the generated actions module
- `withSchema(schema, handler)` — payload sugar + local decode; Rpc rejects bad Encoded with `-32602`
- `liveQuery` / `publish` for isolate-local topic snapshots (async generators over WS)
- `oxidejs/mutation-queue` — client write queue with idempotency keys for `transport: "ws"`
- `OxideRequest` / `OxideCtx` Context services; Effect handlers and Effect `Stream` (`{ stream: true }`)
- `oxidejs.action` spans / log annotations (`rpc.method`)
- Official `templates/kit` (celld + D1 + live list); `templates/tasks` removed

### Changed

- Schema / Rpc payload decode errors scrub to `-32602` with the Schema Die message when available
- Schema-tagged Fail (`error` schema) scrubs to application error `-32000`
- Website docs rewritten around typed actions; `effect` is a website dependency for Twoslash

### Notes

- Effect remains `4.0.0-rc.*`; Rpc / Atom / HTTP live under `effect/unstable/*`
- Prefer `Schema.TaggedError` + `Effect.fail` (or throw the tagged error) for wire Fail — returning an `Error` as a value does not promote it over RPC
- Client Rpc codegen still uses `Unknown` payloads; TypeScript comes from `*.server.ts` source
