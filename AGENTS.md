# AGENTS.md

## Project overview

- Oxide is "the backend unframework" — a Bun monorepo for small, typed full-stack apps. Server entry plus server actions. Nothing else.
- Two packages: `oxidejs` (Vite/Rsbuild plugin) and `tacho` (typed JSON-RPC). Templates live in `templates/`.
- `oxidejs` is one unplugin: one build → `dist/server.js`, optional `dist/client/`, server actions from `*.server.ts`.
- `tacho` is the RPC layer those actions ride on. Runtime-agnostic. Fetch, SSE streams, files, WebSocket.
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

- `packages/oxidejs/src/` — unplugin core (`index.ts`), options (`core.ts`), server-action scan/stubs (`actions.ts`), Vite/Rsbuild entrypoints.
- `packages/tacho/src/index.ts` — router, `RpcError`, `runOne` / `runBatch`, `rpcResult`.
- `packages/tacho/src/transport/` and `packages/tacho/src/client/` — fetch/ws servers and clients. Keep them thin.
- `templates/` — official starters (`ilha`, `xsaf`). Keep them copy-pasteable. No extra build steps.
- `apps/website/` — Blume site (`docs/`, `pages/`). Do not invent a second docs system.

## oxidejs conventions

- Default preset is `"fetch"`. `"celld"` writes `dist/wrangler.jsonc` and skips asset serving (Wrangler `ASSETS` does that).
- `*.server.ts` / `*.server.js` are server-only. Client imports become tacho stubs that POST `/_action`. Method names are `<file>.<fn>` (`test.ping`).
- Return `undefined` from `src/server.ts` to fall through to static files / `index.html`.
- `async function*` exports stream over tacho SSE.
- `clientDir` must stay inside `outDir`. Unknown wrangler keys fail at build time.
- Non-goals: no `wrangler dev` / workerd emulation, no automatic `celld deploy`, no Node-builtin polyfills.

## tacho conventions

- Procedures are callable in-process (`await router.ping()`) and over the wire. `typeof router` is the client.
- Schemas are Standard Schema (`zod`, `valibot`, `arktype`, …). Failed input is `INVALID_PARAMS`. Failed output is `INTERNAL_ERROR`.
- Middleware is onion: `return next({ ctx })`. Skip `next()` to skip the handler.
- Throw `RpcError` from a procedure or middleware for a custom JSON-RPC error. Plain `Error` becomes `INTERNAL_ERROR` with the message kept, no stack.
- `rpcResult` throws `RpcError`. Clients check with `instanceof RpcError`.
- CORS is not built in. Wrap `handle()`.

## Errors

This repo follows the [errore.org](https://errore.org/) convention **without** the `errore` package. Errors as values. No Result wrapper. No new error-handling dependency.

```ts
class NotFoundError extends Error {
  constructor(public id: string) {
    super(`User ${id} not found`);
  }
}

async function getUser(id: string): Promise<User | NotFoundError> {
  const user = await db.find(id);
  if (!user) return new NotFoundError(id);
  return user;
}

const user = await getUser(id);
if (user instanceof Error) return user;
console.log(user.name);
```

- Recoverable failures: return `T | SpecificError`. Callers use `instanceof`. Forget to check and TypeScript will not compile.
- Programmer / config / invariant failures: throw. Plugin options, bad wrangler keys, paths outside `outDir` stay throws.
- JSON-RPC boundary: throw `RpcError` inside procedures. `runOne` turns it into a JSON-RPC error object. Do not invent a second protocol error type.
- Never add `neverthrow`, Effect, or a custom `Result<T, E>`. `T | Error` is the union.
- Never install `errore` just for `createTaggedError` / `matchError`. A small `class X extends Error` is enough.
- Do not swallow errors in empty `catch`. Wrap throwing stdlib (`JSON.parse`) only at a trust boundary, and return a typed `Error`.

## Testing

- Tests live next to the code (`*.test.ts`) and run with `bun test`.
- Cover the path you changed. RPC changes need a dispatch test and a client/transport test when the wire shape moves.
- Run `bun run test` from the repo root before a PR.

## Writing docs

Package READMEs (`packages/oxidejs/README.md`, `packages/tacho/README.md`) ship with the packages. Update them when public behavior changes.

- Address the reader as "you."
- Active voice. Short sentences. No "simply," "just," "powerful," "blazing."
- Show, then explain. Examples must typecheck and copy-paste.
- One term per concept: `preset`, `workerEntry`, `*.server.ts`, `/_action`, `RpcError`, `handle()`, `createClient`.
- New public API updates the relevant README. Format with `bun run fmt`.

## Agent behavior

- Smallest change that works. Do not add files, deps, or abstractions "for later."
- Prefer stdlib and what is already in the repo. `unplugin` is the only oxidejs runtime dep. `crossws` is an optional tacho peer.
- Prefer TypeScript inference over explicit annotations. Do not annotate function, async function, or generator return types when TypeScript can infer them correctly.
- Keep public exports stable. New entrypoints need a reason and a README update.
- If a request contradicts this file (add a Result library, emulate `wrangler dev`, drop Bun, merge tacho into oxidejs), stop and ask.

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

- Use function components over class components
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
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
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
