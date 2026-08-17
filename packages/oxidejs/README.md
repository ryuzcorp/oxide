# oxidejs

One build command → a deployable tree:

```
dist/
├── client/           # only if index.html exists
└── server.js         # ESM server bundle
```

`preset: "celld"` also writes `dist/wrangler.jsonc` with `main: "./server.js"`.

v1 targets **Vite** and **Rsbuild** via unplugin. Other bundlers are out of scope for now.

## Vite

```ts
// vite.config.ts
import { defineConfig } from "vite";
import oxide from "oxidejs/vite";

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

Default preset is `"fetch"`. No `index.html` → only `dist/server.js`. With `index.html` → client to `dist/client/`, then `/_action` (if you have `*.server.ts`) → `src/server.ts` (`undefined` continues) → static file → `index.html` for navigations. `public/` is copied next to the client. Hashed assets get `Cache-Control: immutable`. No `wrangler.jsonc`.

```ts
oxide({
  preset: "celld",
  wrangler: { name: "my-app", compatibility_date: "2026-01-01" },
});
```

`"celld"` writes `dist/wrangler.jsonc` for celld, a self-hosted alternative to Cloudflare Workers, and skips asset serving (`ASSETS` does that).

## Server actions

Install `tacho` if you use actions. Files named `*.server.ts` / `*.server.js` are server-only. A client import is replaced with a tacho stub that POSTs `/_action`. The original module never enters the client graph. Server and Vite SSR (`import.meta.env.SSR === true`) keep the real functions. Methods are `<file>.<fn>` (`test.ping`). Call `useRequest()` inside an action for the inbound `Request`. Return `undefined` from `src/server.ts` to fall through to static files. No `*.server.ts` → the bundle does not import tacho.

```ts
// src/test.server.ts
import { useRequest } from "oxidejs";

export async function who() {
  return useRequest().headers.get("x-user");
}

export async function ping() {
  return "pong";
}

// src/client.ts
import { ping } from "./test.server";
console.log(await ping()); // "pong"

// src/server.ts
export default {
  fetch(request: Request) {
    if (new URL(request.url).pathname === "/api/ok") return new Response("ok");
  },
};
```

`async function*` exports stream over tacho SSE. `oxidejs/tsconfig` makes `await ticks()` typecheck.

`vite dev` and `rsbuild dev` serve `/_action` via middleware. `oxide({ actions: "ws" })` uses a WebSocket instead (needs `crossws`; not with `preset: "celld"`). `actionHeaders` are static headers on the shared HTTP client.

## Rsbuild

```ts
// rsbuild.config.ts
import { defineConfig } from "@rsbuild/core";
import oxide from "oxidejs/rsbuild";

export default defineConfig({
  plugins: [oxide()],
});
```

Same factory as Vite: client stubs, `/_action`, and `dist/server.js`.

## Options

| Option                         | Default                  | Notes                                  |
| ------------------------------ | ------------------------ | -------------------------------------- |
| `preset`                       | `"fetch"`                | `"fetch"` or `"celld"`                 |
| `workerEntry`                  | `src/server.ts`          | Relative to project root               |
| `outDir`                       | `dist`                   | Output root                            |
| `clientDir`                    | `client`                 | Must stay inside `outDir`              |
| `wrangler.name`                | required if `emitConfig` |                                        |
| `wrangler.compatibility_date`  | required if `emitConfig` |                                        |
| `wrangler.compatibility_flags` | —                        | optional                               |
| `wrangler.durable_objects`     | —                        | optional                               |
| `wrangler.migrations`          | —                        | optional                               |
| `wrangler.services`            | —                        | optional                               |
| `wrangler.vars`                | —                        | optional                               |
| `emitConfig`                   | `true` on `celld`        | Set `false` to skip `wrangler.jsonc`   |
| `actions`                      | `"http"`                 | `"ws"` needs `crossws`; not with celld |
| `actionHeaders`                | —                        | Static headers on the HTTP client      |

`main` is always `./server.js`. `assets` is added only when `index.html` exists. Unknown wrangler keys fail at build time.

## Non-goals

- No `wrangler dev` / workerd emulation
- No automatic `celld deploy`
- No Node-builtin polyfills — Vite `ssr.noExternal: true` is a hard-fail for stray Node imports
