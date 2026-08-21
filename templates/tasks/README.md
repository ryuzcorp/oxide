# Tasks

A small Oxide app using the default `fetch` preset, Ilha, and typed server actions.

It demonstrates:

- `action()` exports from `src/tasks.server.ts`
- an SSE action stream consumed with `for await`
- request cancellation with `useRequest().signal`
- in-memory task storage with `unstorage`
- an Ilha page in `src/pages/index.tsx`

## Run

```sh
bun install
bun run dev
```

Open the URL printed by Vite.

## Build

```sh
bun run build
node dist/server.js
```

Oxide writes the browser bundle to `dist/client/` and the server to `dist/server.js`. The in-memory task store resets when the server process restarts.
