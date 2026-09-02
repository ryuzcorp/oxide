import { AsyncLocalStorage } from "node:async_hooks";

const ALS_KEY = Symbol.for("oxidejs.requestContext");
const FETCH_KEY = Symbol.for("oxidejs.fetch");

export type ExecutionContext = {
  waitUntil?(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
};

/** RPC procedure request context. Starts as `{ req }` plus Worker extras. Middleware can add fields. */
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

/** Current RPC or host request context. Throws outside request handling. */
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

/** Worker `ctx` from `fetch(request, env, ctx)` (`waitUntil`). `undefined` on Node. */
export function useFetchCtx(): ExecutionContext | undefined {
  return store().fetchCtx;
}

export function runWithRequest<T>(req: Request, fn: () => T, extra?: Partial<ActionContext>): T {
  return als().run({ ...extra, req }, fn);
}

const HOOK_KEY = Symbol.for("oxidejs.runWithRequest");
(globalThis as AlsGlobal)[HOOK_KEY] ??= (req: Request, fn: () => unknown) => {
  const extra = (req as unknown as Record<symbol, Partial<ActionContext> | undefined>)[FETCH_KEY];
  return runWithRequest(req, fn as () => unknown, extra);
};

export {
  action,
  brandServerAction,
  wrapClientRpc,
  wrapClientStreamRpc,
  ACTION_CALL,
} from "./action";
export type { ServerActionHandle, StreamActionHandle } from "./action";
