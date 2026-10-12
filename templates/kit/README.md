# Kit

Oxide + `@cloudflare/vite-plugin` with D1. Server actions use WebSocket (`actions: "ws"`). Tasks use `liveQuery` over ParanORM 0.3.2 + `@effect/sql-d1`. Auth is Better Auth on D1 with passkeys.

Local and Cloudflare deploy use the same Vite path (workerd). `preset` defaults to `"worker"` because `cloudflare.config.ts` is present. celld can still consume the build output.

## Pages

- `/` — your tasks (redirects to `/login` when signed out)
- `/login` — passkey register / sign-in (redirects to `/` when signed in)

## Auth

- One `defineSchema` YAML (`1.0.0`) for Better Auth core/admin + `passkey` + `tasks`, with `_extends: [idempotency]` only — no auth macro. Recipe: [paranorm DOCS.md](https://github.com/ryuzcorp/paranorm/blob/main/DOCS.md). `InferSchema` / `createMigrator` share that value; auth rows are still queried through Better Auth.
- `tasks.userId` references `user.id`. Actions require a session and only read/write that user's rows (`liveQuery` topic `tasks:<userId>`).
- `/api/auth/*` is handled in `src/server.ts` with a per-request Better Auth instance bound to `env.DB`.
- Registration is passkey-first (`requireSession: false`): name + email → WebAuthn → user row + session. Sign-in uses `signIn.passkey()`.
- Set `BETTER_AUTH_SECRET` (and optionally `BETTER_AUTH_URL`) via `.dev.vars` locally (`cp .dev.vars.example .dev.vars`). Production builds merge those into `dist/wrangler.json` `vars` for celld. For Cloudflare, after the first deploy run `cf workers secrets update BETTER_AUTH_SECRET` (and usually `BETTER_AUTH_URL` to your `*.workers.dev` origin). Do not commit real secrets in `cloudflare.config.ts`.
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

Home page **Files** card uploads via `POST /api/files` (multipart) and lists/deletes through actions. Storage is [unstorage](https://unstorage.unjs.io/drivers/cloudflare#cloudflare-r2-binding) `cloudflare-r2-binding` on binding `FILES` (auto-provisioned on first Cloudflare deploy). Keys are unstorage-normalized (`u:<userId>:<filename>`).

## Workflow + queue demo

`src/lib/demo.server.ts` exports `workflow()` (`DEMO`), `queue({ workflow: demo, producerStart: true })` (`DEMOS`), and `schedule({ cron: "0 * * * *", workflow: demo })` (`demo-hourly`). The home page card can start a workflow directly or enqueue a message — `send` returns `{ id }` so you can poll the same status UI. `producerStart` makes enqueue progress on celld (same-worker consumers do not run with `fetch`); on Cloudflare the consumer also runs and create is idempotent. Leave `producerStart` off on Cloudflare-only apps if you want queue semantics alone.

Scanned durable bindings reach the Cloudflare config two ways: `withOxide` merges them for plain `vite` builds, and `oxideDurable` (`oxidejs/cf`, spread in `cloudflare.config.ts`) declares them for `cf deploy`, whose build rejects any `config` customizer.

## Run (Cloudflare Vite)

```sh
bun install
bun run cf:login   # once
bun run dev        # vite + workerd (D1 / R2 / queues local)
```

Root `cloudflare.config.ts` owns name, compat, D1/R2/`workersDev`. Oxide provides `virtual:oxide/worker` (`src/worker.ts` re-exports it) and merges workflows/queues/crons.

Passkeys need a secure context (HTTPS or `localhost`).

## Build / deploy (Cloudflare)

```sh
bun run build
bun run deploy     # cf deploy (builds from cloudflare.config.ts)
# optional: cf workers secrets update BETTER_AUTH_SECRET
```

Output layout: Worker + snapshot config in `dist/ssr/`, client assets in `dist/client/`. First deploy auto-provisions D1 (`kit`), R2 (`files` via binding `FILES`), and the `demos` queue. Keep Assets `notFoundHandling` at `none` in `cloudflare.config.ts` — oxide SPA-falls-back document navigations; Cloudflare's `single-page-application` mode returns `index.html` for missing hashed `/assets/*` and breaks client loads after deploy.

Optional: set `BETTER_AUTH_URL` to your `*.workers.dev` (or custom) origin after the first deploy if passkeys need a stable RP ID.

## Docker / Podman (one-click celld demo)

Runs [RustFS](https://docs.rustfs.com/en/installation/container/docker) (S3) + [celld](https://github.com/denoland/celld) + a one-shot kit build/deploy. Fully-qualified images (`docker.io/…`, `ghcr.io/…`) so Podman works without a short-name registry config.

One command brings the stack up. `compose.yaml` orders the services with `depends_on` conditions, so plain `docker compose up` is enough — no shell sequencing and no race:

1. `rustfs` becomes healthy (`/health/ready`).
2. `rustfs-init` creates the `celld` bucket and exits.
3. `kit` builds and runs `celld deploy`, then POSTs `/reload`.
4. `celld` starts on a bucket that already has `deploy/current.json`.

```sh
cp .env.example .env    # optional — change secrets before any non-localhost bind
docker compose up --build -d   # or: make up
docker compose logs -f celld rustfs   # or: make logs
docker compose down -v  # or: make down
```

| Service        | URL                   |
| -------------- | --------------------- |
| Kit (celld)    | http://localhost:8080 |
| RustFS S3      | http://localhost:9000 |
| RustFS console | http://localhost:9001 |

Defaults ship with demo RustFS keys and `BETTER_AUTH_SECRET` and publish **8080/9000/9001**. Treat that as localhost-only.

The deploy job POSTs `/reload` to `http://celld:8081/reload` (`CELLD_RELOAD_URL`) after `celld deploy`, so a redeploy goes live without waiting for the poll. On the first `up` celld is not running yet, so the job skips the reload and celld loads the deployment on start.

| Setting | Purpose |
| --- | --- |
| `CELLD_DEPLOY_POLL_S` | Fallback poll interval (default **300** in this demo). `/reload` is the fast path. |
| `CELLD_DEPLOY_MAX_AGE_S` | With `actions: "ws"`, how long a resident Durable Object may keep old code before a forced cutover (open WebSockets closed with 1012). Default 60. |
| `CELLD_ASSET_CACHE_DIR` | Per-node asset cache at `/var/lib/celld/asset-cache`. celld's default `/tmp/celld/asset-cache` is shared by every node and created `0700`, which crash-loops a node that serves assets as another user. |
| `CELLD_ASSET_CACHE_BYTES` | Cache bound (default 256 MiB here; celld's own default is 512 MiB). |
| `CELLD_TRUST_FORWARDED_HEADERS` | Set to `1` only behind a trusted proxy that replaces `X-Forwarded-Host` and `X-Forwarded-Proto`. Off by default — the demo binds celld directly. |
| `CELLD_SHUTDOWN_TOTAL_MS` | Node stop bound (default 15s). `compose.yaml` sets `stop_grace_period: 25s`, which must exceed it. |

Deploy CLI and the `celld` service both use pinned `ghcr.io/denoland/celld:0.6.1` (binary copied into the kit image; bump `CELLD_VERSION` in `Dockerfile` and `compose.yaml` together).

The kit image installs registry `oxidejs` (see `bun.lock`); it does **not** use `packages/oxidejs` from this monorepo. `bun run release -n oxidejs -b patch` rewrites the `oxidejs` range in this template's `package.json` and refreshes `bun.lock` for the image build, so the template tracks the released version (`bun install` refreshes the root lockfile).

Passkeys need a secure context — `http://localhost:8080` is fine. Set `BETTER_AUTH_URL` if you publish on another host.

## Run / deploy (celld)

```sh
bun run build
bun run dev:celld       # vite build → celld dev dist
bun run deploy:celld    # vite build → celld deploy dist
```

`@cloudflare/vite-plugin` writes `dist/ssr/wrangler.json` with CF-only keys (`no_bundle`, `workers_dev`, …), paths like `assets.directory: "../client"` (illegal for celld), `dist/client/.assetsignore`, and bare `import "node:fs"` leftovers. Every production `vite build` with that snapshot also runs `prepareCelldDeploy` and writes `dist/wrangler.json` with celld-safe keys/paths (`main: "celld/entry.js"`, `assets.directory: "client"`), strips `.assetsignore`, drops `no_bundle` so `celld deploy` esbuilds one module, and writes a stripped entry under `dist/celld/` (not beside Cloudflare's `ssr/` main). Cloudflare `cf deploy` builds from `cloudflare.config.ts` instead. Needs `esbuild` on `PATH`.

A **running** celld node does not restart on deploy. It adopts `deploy/current.json` when asked, and otherwise polls it every `CELLD_DEPLOY_POLL_S` seconds (celld's default is 30; the compose demo sets **300** because the reload makes the poll a fallback only).

`POST /reload` on the node's internal listener makes it adopt the pointer now. The compose deploy job calls it after `celld deploy` (`CELLD_RELOAD_URL`, default `http://celld:8081/reload`), and the runner does the same in production. You do not need to curl it by hand; if you run a node outside compose, `celld` logs the internal listener address (or read it from `GET /state`) and you can `curl -X POST "http://127.0.0.1:<internal-port>/reload"` yourself.

Kit uses `actions: "ws"`. A resident Durable Object moves to new code only at a safe point — no open request, alarm, or regular WebSocket. An object that reaches no safe point within `CELLD_DEPLOY_MAX_AGE_S` seconds (default **60**) is forced: celld cancels its work and closes its WebSockets with 1012. Set it to `0` to force every resident object at adoption.

Deploying into the compose stack also carries the node settings you must keep for a real proxy or a real fleet:

- `CELLD_ASSET_CACHE_DIR` puts the asset cache in the node's own state dir. celld's default, `/tmp/celld/asset-cache`, is one directory shared by every node in a container and created `0700` by whichever starts first, so a node that serves assets as another user crash-loops on `EACCES`. `CELLD_ASSET_CACHE_BYTES` bounds it.
- `CELLD_TRUST_FORWARDED_HEADERS=1` only when a trusted reverse proxy replaces both `X-Forwarded-Host` and `X-Forwarded-Proto`; without it celld builds redirects and links from the wrong host/scheme, and with it but no trusted proxy a client can spoof the host.

Set `CELLD_SHUTDOWN_TOTAL_MS` below the orchestrator's stop grace (`compose.yaml` uses 15s under `stop_grace_period: 25s`) so the node can seal its node log and hand off before SIGKILL.
