import { AsyncLocalStorage } from "node:async_hooks";

const ALS_KEY = Symbol.for("oxidejs.requestContext");

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
  if (!current) throw new Error("oxidejs: useRequest() called outside an action");
  return current;
}

/** Current tacho `ctx`. Throws outside `*.server.ts` running over `/__oxide/action`. */
export function useCtx<C extends ActionContext = ActionContext>(): C {
  return store() as C;
}

/** Current action `Request`. Throws outside `*.server.ts` running over `/__oxide/action`. */
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

export function runWithRequest<T>(req: Request, fn: () => T, extra?: ActionContext): T {
  return als().run(extra ?? { req }, fn);
}

/** Optional last argument on a `*.server.ts` export so the client can pass `{ signal }`. */
export type ActionOptions = { signal?: AbortSignal };

/**
 * Marks a `*.server.ts` export as a remote RPC action. Identity: returns `fn` unchanged.
 * Only exports wrapped in `action()` become callable over the wire; other exports stay
 * server-local. Wrap async functions and async generators.
 */
export function action<T>(fn: T): T {
  return fn;
}
