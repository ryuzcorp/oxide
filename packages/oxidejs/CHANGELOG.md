# Changelog

## 0.5.0

### Added

- `workflow()` + `*.server.ts` (worker): Cloudflare Workflows driver — class export, wrangler `workflows`, RPC `start` / `status` / `send` (no separate `*.workflow.ts`)
- `queue({ name, workflow })` + `*.server.ts` (worker): Cloudflare Queues — wrangler `queues` producers/consumers, same-worker `queue` handler starts the workflow per message, RPC `send` / `sendBatch` return client-chosen `{ id }` / `{ ids }` (CF does not expose message ids on send)
- `schedule({ name, cron, workflow })` + `*.server.ts` (worker): Cron triggers — wrangler `triggers.crons`, same-worker `scheduled` handler starts workflow (id `` `${name}:${scheduledTime}` ``) or `queue` / `handle`
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
