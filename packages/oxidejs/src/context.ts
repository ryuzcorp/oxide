import { AsyncLocalStorage } from "node:async_hooks";

const ALS_KEY = Symbol.for("oxidejs.requestContext");
const FETCH_KEY = Symbol.for("oxidejs.fetch");

export type ExecutionContext = {
  waitUntil?(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
};

/** Tacho procedure `ctx`. Starts as `{ req }` plus Worker extras. Middleware can add fields. */
export type ActionContext = {
  req: Request;
  env?: unknown;
  fetchCtx?: ExecutionContext;
  [key: string]: unknown;
};

type AlsGlobal = typeof globalThis & { [key: symbol]: unknown };

function als(): AsyncLocalStorage<ActionContext> {
  const g = globalThis as AlsGlobal;
  return (g[ALS_KEY] ??=
    new AsyncLocalStorage<ActionContext>()) as AsyncLocalStorage<ActionContext>;
}

function store(): ActionContext {
  const current = als().getStore();
  if (!current) throw new Error("oxidejs: request context is unavailable");
  return current;
}

/** Current tacho or host request context. Throws outside request handling. */
export function useCtx<C extends ActionContext = ActionContext>(): C {
  return store() as C;
}

/** Current server `Request`. Available in actions, SSR, and frame renders. */
export function useRequest(): Request {
  return store().req;
}

/** Worker `env` from `fetch(request, env, ctx)`. `undefined` on the Node fetch preset. */
export function useEnv<E = unknown>(): E | undefined {
  return store().env as E | undefined;
}

/** Worker `ctx` from `fetch(request, env, ctx)` (`waitUntil`). Not tacho `ctx`. `undefined` on Node. */
export function useFetchCtx(): ExecutionContext | undefined {
  return store().fetchCtx;
}

export function runWithRequest<T>(req: Request, fn: () => T, extra?: Partial<ActionContext>): T {
  return als().run({ ...extra, req }, fn);
}

// Install a globalThis slot so host frameworks can enter the action scope
// around their own request handling — same pattern as the Symbol.for keys
// above. @ilha/router's frame/SSR middleware consults this so `useRequest()`
// and `useEnv()` work outside `/__oxide/action` too.
const HOOK_KEY = Symbol.for("oxidejs.runWithRequest");
(globalThis as AlsGlobal)[HOOK_KEY] ??= (req: Request, fn: () => unknown) => {
  // SAFETY: the generated wrapper stores Partial<ActionContext> under this shared Symbol.for key.
  const extra = (req as unknown as Record<symbol, Partial<ActionContext> | undefined>)[FETCH_KEY];
  return runWithRequest(req, fn as () => unknown, extra);
};

/**
 * Marks a `*.server.ts` export as a remote RPC action. Runtime identity; the
 * second call signature adds the transport-only `{ signal }` argument.
 */
export function action<Args extends unknown[], Result>(fn: (...args: Args) => Result) {
  // SAFETY: the client transform removes the final options object before RPC dispatch;
  // server and in-process calls still execute this original function unchanged.
  return fn as typeof fn & ((...args: [...Args, options: { signal?: AbortSignal }]) => Result);
}
