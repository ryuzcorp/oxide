# Kit

Oxide on the worker preset (Cloudflare Workers; kit dev/deploy uses celld) with D1. Server actions use WebSocket (`actions: "ws"`). Tasks use `liveQuery` over ParanORM 0.3.2 + `@effect/sql-d1`. Auth is Better Auth on D1 with passkey registration.

## Pages

- `/` — your tasks (redirects to `/login` when signed out)
- `/login` — passkey register / sign-in (redirects to `/` when signed in)

## Auth

- One `defineSchema` YAML (`1.0.0`) for Better Auth core/admin + `passkey` + `tasks`, with `_extends: [idempotency]` only — no auth macro. Recipe: [paranorm DOCS.md](https://github.com/ryuzcorp/paranorm/blob/main/DOCS.md). `InferSchema` / `createMigrator` share that value; auth rows are still queried through Better Auth.
- `tasks.userId` references `user.id`. Actions require a session and only read/write that user's rows (`liveQuery` topic `tasks:<userId>`).
- `/api/auth/*` is handled in `src/server.ts` with a per-request Better Auth instance bound to `env.DB`.
- Registration is passkey-first (`requireSession: false`): name + email → WebAuthn → user row + session. Sign-in uses `signIn.passkey()`.
- Set `BETTER_AUTH_SECRET` (and optionally `BETTER_AUTH_URL`) in wrangler `vars`. The template ships a local-only secret — replace it before deploy.
- `advanced.database.validateSchema` is off: Better Auth's check uses `pragma_table_info(?)`, which D1 rejects (`SQLITE_AUTH`). ParanORM migrations are the source of truth.

## Live list

- `list` is an async generator over `liveQuery.subscribe` (topic `tasks:<userId>`).
- Mutations call `liveQuery.mutate` so open subscribers get a new snapshot.
- Do **not** use paranorm `once()` on D1 — it checks `SELECT changes()` in a follow-up statement, which is always 0 there, so writes never run.
- Actions stamp Schema `error` (`UnauthorizedError`); mutations use `withSchema` for payloads.
- The UI wraps mutations with `oxidejs/mutation-queue` (Schedule backoff on `flush`) so transient WS drops enqueue and replay.

`src/middleware/db.ts` stamps `env.DB` onto the request context. Capture `useDb()` before the first await on Workers.

UI stays in `$lib/*` (not `*.server.*`).

## Files (R2)

Home page **Files** card uploads via `POST /api/files` (multipart) and lists/deletes through actions. Storage is [unstorage](https://unstorage.unjs.io/drivers/cloudflare#cloudflare-r2-binding) `cloudflare-r2-binding` on wrangler binding `FILES` (`bucket_name: kit-files`). Keys are unstorage-normalized (`u:<userId>:<filename>`).

## Workflow + queue demo

`src/lib/demo.server.ts` exports `workflow()` (`DEMO`), `queue({ workflow: demo, producerStart: true })` (`DEMOS`), and `schedule({ cron: "0 * * * *", workflow: demo })` (`demo-hourly`). The home page card can start a workflow directly or enqueue a message — `send` returns `{ id }` so you can poll the same status UI. `producerStart` makes enqueue progress on celld (same-worker consumers do not run with `fetch`); leave it off on Cloudflare-only apps so queue semantics control execution.

## Run

```sh
bun install
bun run build
celld dev dist
```

`vite dev` has no Worker D1 binding. Use `celld dev dist` after a build so `env.DB` is available.

Passkeys need a secure context (HTTPS or `localhost`). Wipe the local D1 if you still have a pre-`userId` tasks table (`celld dev dist --clean`).

## Build and deploy

```sh
bun run build
bun run deploy   # celld deploy dist → writes deploy/current.json in the fleet bucket
```

A **running** celld node does not restart on deploy. It polls `deploy/current.json` every **30s** (`CELLD_DEPLOY_POLL_S`) and only then builds/adopts the new Worker + assets. That lag is what feels like “UI takes a minute to work.”

Make it instant after deploy:

```sh
# Internal listener port is in celld logs / GET /state (default binds 127.0.0.1:0).
curl -X POST "http://127.0.0.1:<internal-port>/reload"
```

Or lower the poll (`CELLD_DEPLOY_POLL_S=1`), or restart the node so it loads `deploy/current` at boot.

Also: kit uses `actions: "ws"`. Open WebSockets block a “safe” Durable Object cutover until `CELLD_DEPLOY_MAX_AGE_S` (default **60**) forces them closed with 1012 — another way the UI can look stale for about a minute after adopt. Reload/restart (or close tabs) avoids waiting on that.
