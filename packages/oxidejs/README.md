# oxidejs

One build command → a deployable tree:

```
dist/
├── client/           # only if index.html exists
└── server.js         # ESM server bundle
```

`preset: "celld"` also writes `dist/wrangler.jsonc` with `main: "./server.js"`.

v1 targets **Vite** and **Rsbuild** via unplugin. Other bundlers are out of scope for now.

The `oxidejs` entry exports runtime helpers (`action`, `useRequest`, …). The bundler plugin lives at `oxidejs/vite` or `oxidejs/rsbuild` — keep those separate so `*.server.ts` can import `oxidejs` under `preset: "celld"` without pulling Node build tooling into the worker graph.

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

Default preset is `"fetch"`. No `index.html` → only `dist/server.js`. With `index.html` → client to `dist/client/`, then `/__oxide/action` (if you have a `*.server.{ts,tsx,js,jsx}` file) → `src/server.ts` (`undefined` continues) → static file → `index.html` for navigations. `public/` is copied next to the client. Hashed assets get `Cache-Control: immutable`. No `wrangler.jsonc`.

```ts
oxide({
  preset: "celld",
  wrangler: { name: "my-app", compatibility_date: "2026-01-01" },
});
```

`"celld"` writes `dist/wrangler.jsonc` for celld, a self-hosted alternative to Cloudflare Workers, and skips asset serving (`ASSETS` does that). The generated worker imports `oxidejs/worker-dom/install` so Ilha SSR has a DOM before your entry evaluates. Oxide merges `nodejs_compat` into `compatibility_flags` when you do not set it.

## Server actions

Files named `*.server.ts`, `*.server.tsx`, `*.server.js`, or `*.server.jsx` are server-only. A client import is replaced with an Effect RPC stub that POSTs `/__oxide/action` as newline-delimited JSON-RPC (`application/json-rpc`). The original module never enters the client graph. **Only exports wrapped in `action()` become remote actions** — any other export stays server-local and is not callable over the wire. Server and Vite SSR (`import.meta.env.SSR === true`) keep the real functions. Methods are `<file>.<fn>` (`test.ping`). Call `useRequest()` inside an action for the inbound `Request`. `useCtx()` is the request context (`{ req }` plus anything middleware or `createContext` added). On `preset: "celld"`, `useEnv()` and `useFetchCtx()` are the Worker `env` and `ctx` from `fetch(request, env, ctx)` — same values as `useCtx().env` / `useCtx().fetchCtx`. Return `undefined` from `src/server.ts` to fall through to static files. No server action files → the bundle does not import `oxidejs/rpc`. `action()` results are JSON-RPC data — returning a `Response` from an action is an error; return a raw `Response` from `src/server.ts` for raw HTTP responses.

```ts
// src/test.server.ts
import { action, useRequest } from "oxidejs";

export const who = action(async () => {
  return useRequest().headers.get("x-user");
});

export const ping = action(async () => "pong");

// a non-action export is never exposed over the wire
async function internalHelper() {
  /* server-only */
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

### Call shape

Unary actions return a Promise and expose helpers for UI wiring:

| Call                                        | What it does                                     |
| ------------------------------------------- | ------------------------------------------------ |
| `await ping()`                              | Run the action (always invokes RPC on client)    |
| `ping.set(...args)`                         | Same as calling with args; also writes the atom  |
| `ping.bind(...args)` / `ping.with(...args)` | Return an event handler that invokes the action  |
| `ping.result`                               | Read the last `AsyncResult` from the client atom |

`action()` marks the export and adds a typed transport-only `{ signal }` argument. Wrap `async function*` in it to stream over Effect RPC as newline-delimited JSON-RPC (not SSE). On the client the stub returns an async generator — iterate it directly. Inside server code, always read the non-optional signal from `useRequest().signal`:

```ts
// src/test.server.ts
import { action, useRequest } from "oxidejs";

export const ticks = action(async function* (n: number) {
  const { signal } = useRequest();
  for (let i = 0; i < n && !signal.aborted; i++) yield i;
});

// src/client.ts
import { ticks } from "./test.server";

const ac = new AbortController();
for await (const value of ticks(10, { signal: ac.signal })) {
  console.log(value);
}
ac.abort();
```

Stream actions do not support `bind` / `with`. Breaking the `for await` loop or calling `return()` on the generator cleans up the server generator.

`vite dev` and `rsbuild dev` serve the endpoint via middleware. `actions: "http"` (default) serves `/__oxide/action`; `actions: "ws"` uses a WebSocket instead (needs `crossws`; not with `preset: "celld"`). `actions.sameOrigin` defaults to `true` for both transports; set it to `false` only when you intentionally accept cross-origin requests. Set `actions.path` to move the endpoint. `actionHeaders` are static headers on the shared HTTP client and are ignored for WebSocket actions.

## Rsbuild

```ts
// rsbuild.config.ts
import { defineConfig } from "@rsbuild/core";
import oxide from "oxidejs/rsbuild";

export default defineConfig({
  plugins: [oxide()],
});
```

Same factory as Vite: client stubs, `/__oxide/action`, and `dist/server.js`.

## Options

| Option                         | Default                  | Notes                                                                                       |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------- |
| `preset`                       | `"fetch"`                | `"fetch"` or `"celld"`                                                                      |
| `workerEntry`                  | `src/server.ts`          | Relative to project root                                                                    |
| `outDir`                       | `dist`                   | Output root                                                                                 |
| `clientDir`                    | `client`                 | Must stay inside `outDir`                                                                   |
| `wrangler.name`                | required if `emitConfig` |                                                                                             |
| `wrangler.compatibility_date`  | required if `emitConfig` |                                                                                             |
| `wrangler.compatibility_flags` | —                        | optional; `nodejs_compat` is merged in automatically on `celld`                             |
| `wrangler.durable_objects`     | —                        | optional                                                                                    |
| `wrangler.migrations`          | —                        | optional                                                                                    |
| `wrangler.services`            | —                        | optional                                                                                    |
| `wrangler.vars`                | —                        | optional                                                                                    |
| `emitConfig`                   | `true` on `celld`        | Set `false` to skip `wrangler.jsonc`                                                        |
| `actions`                      | `"http"`                 | `"ws"` needs `crossws`; object form: `{ transport, path, sameOrigin }` (`sameOrigin: true`) |
| `actionHeaders`                | —                        | Static headers on the HTTP client                                                           |
| `middleware`                   | `[]`                     | Fetch middleware, run in order before actions and the server entry                          |
| `imports`                      | `[]`                     | Modules imported for side effects at server startup                                         |
| `bodyLimit`                    | `1048576`                | Max Node request body size; larger requests get 413                                         |
| `notFound`                     | —                        | Custom HTML 404 body when no route or asset matches                                         |
| `env`                          | —                        | Node preset value passed to `fetch(request, env, ctx)`                                      |

### `middleware` and `imports`

```ts
oxide({
  middleware: ["@ilha/router/ssr"], // string or { module, imports }
  imports: ["./side-effects"],
});
```

Middleware modules receive `(request, { env, ctx })`. They run before actions, the server entry, and assets. Return a `Response` to stop the chain or `undefined` to continue. Vite loads the same modules through its SSR graph in development. Middleware entries may carry their own `imports`.

`main` is always `./server.js`. `assets` is added only when `index.html` exists. Unknown wrangler keys fail at build time.

## Non-goals

- No `wrangler dev` / workerd emulation
- No automatic `celld deploy`
- No Node-builtin polyfills — Vite `ssr.noExternal: true` is a hard-fail for stray Node imports

## Security

### Asset serving (`preset: "fetch"`)

The generated server serves static files from `dist/client/` (or the `public/` directory merged into it). These guards are active:

| Attack vector                      | Guard                                                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Traversal** (`%2e%2e/`, `..%2f`) | `__rel()` rejects paths containing `..` segments.                                                                                      |
| **Double-slash** (`///etc/passwd`) | `__rel()` rejects results that still start with `/` after `slice(1)`.                                                                  |
| **Null byte** (`%00`, `\0`)        | `__rel()` rejects paths containing null bytes before and after `decodeURIComponent`.                                                   |
| **Absolute path** (`/etc/passwd`)  | `__rel()` returns `null` for paths not starting with `/`.                                                                              |
| **SPA fallback**                   | Unknown paths → `index.html`, never a directory listing.                                                                               |
| **`clientDir` escape**             | `resolveOptions` throws at build time if `clientDir` resolves outside `outDir`.                                                        |
| **Hashed assets**                  | Files matching `[-.][0-9a-f]{8,}.ext` get `Cache-Control: public, max-age=31536000, immutable`. Other files are not cached by default. |

The generated `__asset` function uses `path.join` — not `path.resolve` — so a leading `/` in the relative path stays inside the asset root.

### Server actions (`*.server.{ts,tsx,js,jsx}`)

- Server action code is **never bundled into the client**. Client imports are replaced with Effect RPC stubs that POST the action endpoint (default `/__oxide/action`). The original source stays server-only.
- Only `action()`-wrapped exports are exposed as RPC; other exports stay server-local.
- Stream actions use newline-delimited JSON-RPC (`application/json-rpc`) over that same endpoint — not Server-Sent Events. Frames are scrubbed as they flush on HTTP and WebSocket.
- The endpoint is POST-only. Non-POST requests return `405`.
- Method dispatch uses `Object.hasOwn`, blocking `__proto__` / `constructor` walks.
- Unknown or missing content-types → `415`.
- Body size capped at 1 MB by default (enforced on the actual body, not just `Content-Length`).
- Batch requests capped at 20 items (both HTTP and WebSocket transports).
- Effect `Defect` / `Cause` payloads are scrubbed before they leave the endpoint. Clients see plain JSON-RPC errors (`code` + `message` only). Thrown messages become `Internal error` (`-32603`). Unknown methods → `-32601`; invalid params → `-32602`.
- `actions.sameOrigin` defaults to `true`. Requests without both `Origin` and `Sec-Fetch-Site` are rejected when that check is on.

### Host header

The generated dev server constructs `request.url` from `req.headers.host`. This is standard HTTP/1.1 behavior (same as Express, Hono, Koa, Node http). If your `src/server.ts` reads `request.url` to construct redirects, validate the host yourself — the framework cannot distinguish a legitimate host header from a malicious one. In production, your reverse proxy handles this.
