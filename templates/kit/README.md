# Kit

Oxide + `@cloudflare/vite-plugin` with D1. Server actions use WebSocket (`actions: "ws"`). Tasks use `liveQuery` over ParanORM 0.3.2 + `@effect/sql-d1`. Auth is Better Auth on D1 with passkeys.

Local and Cloudflare deploy use the same Vite path (workerd). `preset` defaults to `"worker"` because `wrangler.jsonc` is present. celld can still consume the build output.

## Pages

- `/` — your tasks (redirects to `/login` when signed out)
- `/login` — passkey register / sign-in (redirects to `/` when signed in)

## Auth

- One `defineSchema` YAML (`1.0.0`) for Better Auth core/admin + `passkey` + `tasks`, with `_extends: [idempotency]` only — no auth macro. Recipe: [paranorm DOCS.md](https://github.com/ryuzcorp/paranorm/blob/main/DOCS.md). `InferSchema` / `createMigrator` share that value; auth rows are still queried through Better Auth.
- `tasks.userId` references `user.id`. Actions require a session and only read/write that user's rows (`liveQuery` topic `tasks:<userId>`).
- `/api/auth/*` is handled in `src/server.ts` with a per-request Better Auth instance bound to `env.DB`.
- Registration is passkey-first (`requireSession: false`): name + email → WebAuthn → user row + session. Sign-in uses `signIn.passkey()`.
- Set `BETTER_AUTH_SECRET` (and optionally `BETTER_AUTH_URL`) via `.dev.vars` locally (`cp .dev.vars.example .dev.vars`). Production builds merge those into `dist/wrangler.json` `vars` for celld. For Cloudflare, after the first deploy run `bunx wrangler secret put BETTER_AUTH_SECRET` (and usually `BETTER_AUTH_URL` to your `*.workers.dev` origin). Do not commit real secrets in `wrangler.jsonc`.
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

Home page **Files** card uploads via `POST /api/files` (multipart) and lists/deletes through actions. Storage is [unstorage](https://unstorage.unjs.io/drivers/cloudflare#cloudflare-r2-binding) `cloudflare-r2-binding` on wrangler binding `FILES` (auto-provisioned on first Cloudflare deploy). Keys are unstorage-normalized (`u:<userId>:<filename>`).

## Workflow + queue demo

`src/lib/demo.server.ts` exports `workflow()` (`DEMO`), `queue({ workflow: demo, producerStart: true })` (`DEMOS`), and `schedule({ cron: "0 * * * *", workflow: demo })` (`demo-hourly`). The home page card can start a workflow directly or enqueue a message — `send` returns `{ id }` so you can poll the same status UI. `producerStart` makes enqueue progress on celld (same-worker consumers do not run with `fetch`); on Cloudflare the consumer also runs and create is idempotent. Leave `producerStart` off on Cloudflare-only apps if you want queue semantics alone.

Scanned durable bindings are merged into wrangler via `withOxide` in `vite.config.ts`.

## Run (Cloudflare Vite)

```sh
bun install
bun run cf:login   # once
bun run dev        # vite + workerd (D1 / R2 / queues local)
```

Root `wrangler.jsonc` owns name, compat, D1/R2/vars/`workers_dev`. Oxide provides `virtual:oxide/worker` (`src/worker.ts` re-exports it) and merges workflows/queues/crons.

Passkeys need a secure context (HTTPS or `localhost`).

## Build / deploy (Cloudflare)

```sh
bun run build
bun run deploy     # wrangler deploy (uses dist/ssr/wrangler.json)
# optional: bunx wrangler secret put BETTER_AUTH_SECRET
```

Output layout: Worker + snapshot config in `dist/ssr/`, client assets in `dist/client/`. First deploy auto-provisions D1 (`kit`), R2 (`files` via binding `FILES`), and the `demos` queue. Keep Assets `not_found_handling` at `none` — oxide SPA-falls back document navigations; Cloudflare's `single-page-application` mode returns `index.html` for missing hashed `/assets/*` and breaks client loads after deploy.

Optional: set `BETTER_AUTH_URL` to your `*.workers.dev` (or custom) origin after the first deploy if passkeys need a stable RP ID.

## Docker / Podman (one-click celld demo)

Runs [RustFS](https://docs.rustfs.com/en/installation/container/docker) (S3) + [celld](https://github.com/denoland/celld) + a one-shot kit build/deploy. Fully-qualified images (`docker.io/…`, `ghcr.io/…`) so Podman works without a short-name registry config.

**`make up` is required.** Plain `docker compose up` / `podman compose up` has no `depends_on` and will race RustFS / an empty fleet (`deploy/current.json` missing). The Makefile sequences: RustFS → bucket → kit deploy → celld.

```sh
cp .env.example .env   # optional — change secrets before any non-localhost bind
make up                # detached; prints the app URL when ready
make logs              # optional: follow celld + rustfs
make down
```

| Service        | URL                   |
| -------------- | --------------------- |
| Kit (celld)    | http://localhost:8080 |
| RustFS S3      | http://localhost:9000 |
| RustFS console | http://localhost:9001 |

Defaults ship with demo RustFS keys and `BETTER_AUTH_SECRET` and publish **8080/9000/9001**. Treat that as localhost-only.

The kit image installs registry `oxidejs` (see `bun.lock`); it does **not** use `packages/oxidejs` from this monorepo. Release oxidejs, bump the kit dep/lockfile, then rebuild the image. Deploy CLI and the `celld` service both use pinned `ghcr.io/denoland/celld:0.4.1` (binary copied into the kit image).

Passkeys need a secure context — `http://localhost:8080` is fine. Set `BETTER_AUTH_URL` if you publish on another host.

## Run / deploy (celld)

```sh
bun run build
bun run dev:celld       # vite build → celld dev dist
bun run deploy:celld    # vite build → celld deploy dist
```

`@cloudflare/vite-plugin` writes `dist/ssr/wrangler.json` with CF-only keys (`no_bundle`, `workers_dev`, …), paths like `assets.directory: "../client"` (illegal for celld), `dist/client/.assetsignore`, and bare `import "node:fs"` leftovers. Every production `vite build` with that snapshot also runs `prepareCelldDeploy` and writes `dist/wrangler.json` with celld-safe keys/paths (`main: "celld/entry.js"`, `assets.directory: "client"`), strips `.assetsignore`, drops `no_bundle` so `celld deploy` esbuilds one module, and writes a stripped entry under `dist/celld/` (not beside Cloudflare's `ssr/` main). Cloudflare `wrangler deploy` still uses the Vite SSR snapshot. Needs `esbuild` on `PATH`.

A **running** celld node does not restart on deploy. It polls `deploy/current.json` every **30s** (`CELLD_DEPLOY_POLL_S`) and only then builds/adopts the new Worker + assets.

Make it instant after deploy:

```sh
# Internal listener port is in celld logs / GET /state (default binds 127.0.0.1:0).
curl -X POST "http://127.0.0.1:<internal-port>/reload"
```

Also: kit uses `actions: "ws"`. Open WebSockets block a “safe” Durable Object cutover until `CELLD_DEPLOY_MAX_AGE_S` (default **60**) forces them closed with 1012.
