import { AsyncLocalStorage } from "node:async_hooks";
import process from "node:process";

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

/** Override for tests. `null` uses `process.versions.webcontainer`. */
let webcontainerOverride: boolean | null = null;

/** StackBlitz WebContainers lose AsyncLocalStorage across `async/await`. */
export const inWebcontainer = (): boolean => {
  if (webcontainerOverride !== null) return webcontainerOverride;
  if (typeof process === "undefined") return false;
  const versions = process.versions as NodeJS.ProcessVersions & {
    webcontainer?: string;
  };
  return Boolean(versions.webcontainer);
};

/** Test-only: force or clear the WebContainer detection path. */
export const __setInWebcontainerForTests = (value: boolean | null): void => {
  webcontainerOverride = value;
};

/** Module fallback when ALS does not survive awaits (WebContainer). */
let syncStore: ActionContext | null = null;

/** Serialize handler *entry* on WebContainer so syncStore is not stomped. */
let entryTail: Promise<void> = Promise.resolve();

function als(): AsyncLocalStorage<ActionContext> {
  const g = globalThis as AlsGlobal;
  return (g[ALS_KEY] ??=
    new AsyncLocalStorage<ActionContext>()) as AsyncLocalStorage<ActionContext>;
}

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  typeof (value as PromiseLike<unknown>).then === "function";

/** Current request context: ALS first, then the WebContainer sync fallback. */
export function getRequestStore(): ActionContext {
  const current = als().getStore() ?? syncStore;
  if (!current) throw new Error("oxidejs: request context is unavailable");
  return current;
}

function store(): ActionContext {
  return getRequestStore();
}

/**
 * Run `fn` with `store` on ALS and the sync fallback. On WebContainer the sync
 * slot is restored only after an async `fn` settles (streams capture the store
 * at invoke time and re-enter via this helper on each pull).
 */
export function withRequestStore<T>(ctx: ActionContext, fn: () => T): T {
  const previous = syncStore;
  syncStore = ctx;
  try {
    const result = als().run(ctx, fn);
    if (inWebcontainer() && isPromiseLike(result)) {
      return Promise.resolve(result).finally(() => {
        if (syncStore === ctx) syncStore = previous;
      }) as T;
    }
    return result;
  } finally {
    if (!inWebcontainer()) {
      syncStore = previous;
    }
  }
}

/**
 * Serialize async work that installs request context on WebContainer.
 * Release as soon as `fn` settles — do not wait for streamed response bodies.
 */
export async function withRequestEntry<T>(fn: () => Promise<T>): Promise<T> {
  if (!inWebcontainer()) return fn();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = entryTail;
  entryTail = gate;
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
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
  return withRequestStore({ ...extra, req }, fn);
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
