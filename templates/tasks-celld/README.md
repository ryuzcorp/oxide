# Tasks on celld

A small Oxide worker using Ilha, typed server actions, and a Durable Object for task storage.

It demonstrates:

- `preset: "celld"` and generated `dist/wrangler.jsonc`
- a `TasksDO` Durable Object declared in `vite.config.ts`
- typed worker bindings through `src/env.ts`
- `action()` exports using `useEnv()` and `useRequest()`
- an SSE action stream consumed with `for await`

## Run locally

```sh
bun install
bun run dev
```

Vite development uses its local server middleware. The production worker uses the celld configuration generated during the build.

## Build and deploy

```sh
bun run build
bun run deploy
```

The build writes `dist/server.js`, `dist/client/`, and `dist/wrangler.jsonc`. Update the worker name, compatibility date, Durable Object bindings, and migrations in `vite.config.ts` before deploying your own app.
