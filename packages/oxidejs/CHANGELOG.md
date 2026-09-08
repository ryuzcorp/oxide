# Changelog

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
- Returning `Error` as a value stays local errore-style — use `Effect.fail` / throw tagged errors for the wire
- Client Rpc codegen still uses `Unknown` payloads; TypeScript comes from `*.server.ts` source
