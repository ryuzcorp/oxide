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

Default preset is `"fetch"`. No `index.html` → only `dist/server.js`. With `index.html` → client to `dist/client/`, then `/_action` → `src/server.ts` (`undefined` continues) → static file → `index.html`. No `wrangler.jsonc`.

```ts
oxide({
  preset: "celld",
  wrangler: { name: "my-app", compatibility_date: "2026-01-01" },
});
```

`"celld"` skips asset serving (Wrangler `ASSETS` does that) and writes `dist/wrangler.jsonc`.

## Server actions

Files named `*.server.ts` / `*.server.js` are server-only. Client imports become tacho stubs that POST `/_action`. Methods are `<file>.<fn>` (`test.ping`). Return `undefined` from `src/server.ts` to fall through to static files.

```ts
// src/test.server.ts
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

`vite dev` and `rsbuild dev` serve `/_action` via middleware.

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

| Option                         | Default                  | Notes                                |
| ------------------------------ | ------------------------ | ------------------------------------ |
| `preset`                       | `"fetch"`                | `"fetch"` or `"celld"`               |
| `workerEntry`                  | `src/server.ts`          | Relative to project root             |
| `outDir`                       | `dist`                   | Output root                          |
| `clientDir`                    | `client`                 | Must stay inside `outDir`            |
| `wrangler.name`                | required if `emitConfig` |                                      |
| `wrangler.compatibility_date`  | required if `emitConfig` |                                      |
| `wrangler.compatibility_flags` | —                        | optional                             |
| `wrangler.durable_objects`     | —                        | optional                             |
| `wrangler.migrations`          | —                        | optional                             |
| `wrangler.services`            | —                        | optional                             |
| `wrangler.vars`                | —                        | optional                             |
| `emitConfig`                   | `true` on `celld`        | Set `false` to skip `wrangler.jsonc` |

`main` is always `./server.js`. `assets` is added only when `index.html` exists. Unknown wrangler keys fail at build time.

## Non-goals

- No `wrangler dev` / workerd emulation
- No automatic `celld deploy`
- No Node-builtin polyfills — Vite `ssr.noExternal: true` is a hard-fail for stray Node imports
