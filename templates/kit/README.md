# Kit

Oxide on celld with D1. Server actions use WebSocket (`actions: "ws"`). Tasks use `liveQuery` over ParanORM 0.3 + `@effect/sql-d1`.

## Live list

- SSR runs `list` in-process (first snapshot).
- The browser resumes the same stream over one shared action WebSocket.
- Mutations call `tasks.mutate(...)` so every client gets a new snapshot.
- Writes go through paranorm `once()` when the client sends an idempotency key.
- `add` uses `withSchema` so Effect Rpc rejects bad payloads before the handler.
- The UI wraps mutations with `oxidejs/mutation-queue` so transient WS drops enqueue and replay.

`src/middleware/db.ts` stamps `env.DB` onto the request context. Actions use `useDb()` / `useCtx().db` (capture before the first await on Workers).

Schema `_extends: [idempotency]` (v1.1.0) creates `paranorm_idempotency` for those keys. Existing kit DBs migrate from v1.0.0 automatically.

UI stays in `$lib/tasks` (not `*.server.*`).

## Run

```sh
bun install
bun run build
celld dev dist
```

`vite dev` has no Worker D1 binding. Use `celld dev dist` after a build so `env.DB` is available.

## Build and deploy

```sh
bun run build
bun run deploy
```
