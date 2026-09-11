# AGENTS.md

## Project overview

- Oxide is "the backend unframework" — a Bun monorepo for small, typed full-stack apps. Server entry plus server actions. Nothing else.
- Package: `oxidejs` (Vite/Rsbuild plugin + Effect RPC actions). Templates live in `templates/`.
- `oxidejs` is one unplugin: one build → `dist/server.js`, optional `dist/client/`, server actions from `*.server.ts`.
- Actions ride Effect RPC (`application/json-rpc` NDJSON) over HTTP or WebSocket (`/__oxide/action`).
- Docs live in `apps/website` (Blume). Package READMEs are the source of truth until the site is real.

## Build and run

- Package manager is Bun. Add deps with `bun add <name>`. Do not change the runtime.
- Before finishing a change:

  - Lint: `bun run lint`
  - Format: `bun run fmt`
  - Types: `bun run typecheck`
  - Tests: `bun run test`
  - Build: `bun run build`

- Docs: `bun run docs:dev` / `bun run docs:build`.
- Packages build with tsdown. Tests use Bun's runner. Lint is oxlint. Format is oxfmt.

## Monorepo structure

- `packages/oxidejs/src/` — unplugin core (`index.ts`), options (`core.ts`), server-action scan/stubs (`actions.ts`), RPC (`rpc/`), Vite/Rsbuild entrypoints.
- `templates/` — official starters (`simple`, `kit`). Keep them copy-pasteable. No extra build steps.
- `apps/website/` — Blume site (`docs/`, `pages/`). Do not invent a second docs system.

## oxidejs conventions

- Default is `"fetch"` when no wrangler config is at the project root; `"worker"` when `wrangler.jsonc` / `wrangler.toml` / `wrangler.json` exists (overridable). Workers apps use `@cloudflare/vite-plugin` + root wrangler (oxide supplies `virtual:oxide/worker`; wrap Cloudflare options with `withOxide` from `oxidejs/wrangler`). Production builds with a Cloudflare Vite `dist/ssr/wrangler.json` snapshot also write a celld-ready `dist/wrangler.json` + `dist/celld/entry.js` via `prepareCelldDeploy` (outside `ssr/` so Cloudflare deploy does not upload a second Worker).
- `*.server.ts` / `*.server.js` are server-only. Client imports become Effect RPC stubs on `/__oxide/action` (HTTP or WebSocket). Method names are `<file>.<fn>` (`test.ping`).
- `workflow()` in `*.server.ts` (`preset: "worker"`): Cloudflare Workflows driver — class export, wrangler `workflows` via `withOxide` / `mergeDurableBindings`, RPC `name.start` / `name.status` / `name.send`. `run(event, { step, env? })` receives a context bag (not a bare `step`).
- `queue({ name, workflow })` in `*.server.ts` (`preset: "worker"`): Cloudflare Queues — wrangler `queues` via merge, same-worker `queue` handler starts the workflow per message (envelope id from `send` → `{ id }`), RPC `name.send` / `name.sendBatch`. Optional `producerStart: true` also starts the workflow from the producer for celld (same-worker consumers do not run with `fetch()`); default off so Cloudflare queue semantics control execution.
- `schedule({ name, cron, workflow })` in `*.server.ts` (`preset: "worker"`): Cron triggers — wrangler `triggers.crons` via merge, same-worker `scheduled` handler starts the workflow with id `` `${name}-${scheduledTime}` `` (or `queue` / `handle` escape). Queue targets inherit `producerStart` from the queue handle.
- Return `undefined` from `src/server.ts` to fall through to static files / `index.html`. Missing the default `src/server.ts` is fine (actions / assets only).
- `async function*` exports stream as NDJSON JSON-RPC over the same action endpoint. Effect `Stream` handlers need `{ stream: true }` (or an async generator).
- `action(fn, { payload?, success?, error? })` stamps Effect Rpc schemas for the generated actions module. `withSchema(schema, fn)` is sugar for `{ payload: schema }` plus a local decode.
- Prefer Effect handlers (`Effect.gen`, `Stream`, Schema-stamped `payload` / `success` / `error`). Yield `OxideRequest` / `OxideCtx` for request context. Promise / `async function*` and `useRequest()` / `useCtx()` still work when Effect would be noise.
- Wire Fail is Schema-tagged via Rpc `error` (`Effect.fail` or throw the tagged error). Returning an `Error` as a value does not promote it over RPC.
- Live queries: prefer `liveQuery.stream` / `subscribeStream` / `mutateEffect` from Effect handlers; async generators remain for compatibility.
- Mutation queue flush retries transient WS failures with Effect `Schedule.exponential` (optional `retries` / `retryBase`).
- Host observability: `oxideRuntimeLayer()` provides a Logger Layer so `oxidejs.action` spans / logs can be collected.
- Action handlers run under an `oxidejs.action` span / log annotations (`rpc.method`). Provide an Effect tracer/logger at the host if you want them collected.
- `actions: "ws"` uses WebSocket (`crossws` on Node, `WebSocketPair` on worker). Answer Effect `@effect/rpc/Ping` with NDJSON `@effect/rpc/Pong`.
- `clientDir` must stay inside `outDir`.
- Non-goals: no oxide-owned workerd emulation (use `@cloudflare/vite-plugin`), no automatic `celld deploy` / `wrangler deploy`, no Node-builtin polyfills.

### Effect roadmap (nice-to-have later)

- Client Rpc codegen: stamp real Schema codecs on the client group (today server meta is authoritative; client still uses `Unknown` payloads).
- Mutation queue: optional durable storage (IndexedDB) on top of Schedule retries.
- Optional Effect LSP / agent-friendly doc patterns (do not bake tsgo into the package).
- Workflow drivers beyond Cloudflare Workers (e.g. Vercel Workflow SDK on fetch).

## Effect & errors

Oxide is Effect-first at the action and RPC boundary. Prefer Effect Schema, `Effect.gen`, services, and `Stream` over Promise error-unions or third-party Result libraries.

```ts
import { Effect, Schema } from "effect";
import { action } from "oxidejs";

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  id: Schema.String,
}) {}

export const getUser = action(
  (id: string) =>
    Effect.gen(function* () {
      const user = yield* findUser(id);
      if (!user) {
        return yield* Effect.fail(new NotFound({ id }));
      }
      return user;
    }),
  { error: NotFound }
);
```

- Recoverable / domain failures: `Schema.TaggedError` + `Effect.fail` (or throw the tagged error). Stamp Rpc `error` so clients get application error `-32000` with tag/message.
- Programmer / config / invariant failures: throw. Plugin options, bad wrangler keys, paths outside `outDir` stay throws.
- JSON-RPC boundary: Effect RPC / scrubbed Defects at the wire. Do not invent a second protocol error type. `SchemaDecodeError` and Rpc payload decode → `-32602`. Schema-tagged Fail (Rpc `error`) → `-32000`. Other Defects → `-32603` Internal error.
- Never add `neverthrow`, `errore`, or a custom `Result<T, E>`. Effect's typed Fail channel is the error model; do not invent a parallel one.
- Do not swallow errors in empty `catch`. At trust boundaries, prefer `Effect.try` / `Effect.tryPromise` (or decode with Schema) over bare `try/catch` that returns an untyped `Error`.

## Testing

- Tests live next to the code (`*.test.ts`) and run with `bun test`.
- Cover the path you changed. RPC changes need a dispatch test and a client/transport test when the wire shape moves.
- Run `bun run test` from the repo root before a PR.

## Writing docs

Package README (`packages/oxidejs/README.md`) ships with the package. Update it when public behavior changes.

- Address the reader as "you."
- Active voice. Short sentences. No "simply," "just," "powerful," "blazing."
- Show, then explain. Examples must typecheck and copy-paste.
- One term per concept: `preset`, `workerEntry`, `*.server.ts`, `/__oxide/action`, `action()`, `createClient`.
- New public API updates the relevant README. Format with `bun run fmt`.

## Agent behavior

- Smallest change that works. Do not add files, deps, or abstractions "for later."
- Prefer Effect (Schema, `Effect.gen`, services, `Stream`) and what is already in the repo over new error/Result libraries. `unplugin` is the only oxidejs runtime dep. `crossws` is optional for Node WebSocket actions.
- Prefer TypeScript inference over explicit annotations. Do not annotate function, async function, or generator return types when TypeScript can infer them correctly.
- Prefer `const name = () => …` or `const name = function () { … }` (anonymous). Never `const name = function name()` — the binding already names it. Same for `Effect.gen(function* () { … })` — no `function* nameGen()`. Disable `func-names` on those files if Ultracite complains.
- Keep public exports stable. New entrypoints need a reason and a README update.
- If a request contradicts this file (add `neverthrow` / `errore` / a Result wrapper, emulate `wrangler dev`, drop Bun, avoid Effect for domain Fail), stop and ask.

# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `bun x ultracite fix`
- **Check for issues**: `bun x ultracite check`
- **Diagnose setup**: `bun x ultracite doctor`

Oxlint + Oxfmt (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Prefer `const name = () => …` or `const name = function () { … }`. Do not repeat the name: never `const Foo = function Foo()`.
- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components (`const Foo = () => …` or `const Foo = function () { … }` — anonymous)
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Prefer Effect Fail (`Schema.TaggedError` + `Effect.fail`) for domain errors; throw only for programmer / config / invariant failures
- Use `try-catch` / `Effect.try` meaningfully — don't catch just to rethrow unchanged
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**

- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**

- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**

- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Oxlint + Oxfmt Can't Help

Oxlint + Oxfmt's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Oxlint + Oxfmt can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Oxlint + Oxfmt. Run `bun x ultracite fix` before committing to ensure compliance.
