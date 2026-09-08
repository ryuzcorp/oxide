import { AsyncLocalStorage } from "node:async_hooks";
import process from "node:process";

import type { OxidejsJson } from "./types";

const ALS_KEY = Symbol.for("oxidejs.requestContext");

export interface ExecutionContext {
  passThroughOnException?: () => void;
  waitUntil?: (
    promise: PromiseLike<OxidejsJson | object | null | undefined>
  ) => void;
}

/** Values middleware may attach on the request context bag. */
export type ActionContextValue =
  | Request
  | ExecutionContext
  | OxidejsJson
  | { [key: string]: OxidejsJson }
  | undefined;

/** RPC procedure request context. Starts as `{ req }` plus Worker extras. Middleware can add fields. */
export interface ActionContext {
  [key: string]: ActionContextValue;
  req: Request;
  env?: { [key: string]: OxidejsJson };
  fetchCtx?: ExecutionContext;
  /** From RPC / HTTP `x-oxide-idempotency-key` when the client sends CallOptions. */
  idempotencyKey?: string;
}

/** Override for tests. `null` uses `process.versions.webcontainer`. */
let webcontainerOverride: boolean | null = null;

/** Override for tests. `null` uses runtime detection. */
let syncRequestStoreOverride: boolean | null = null;

/** StackBlitz WebContainers lose AsyncLocalStorage across `async/await`. */
export const inWebcontainer = function inWebcontainer(): boolean {
  if (webcontainerOverride !== null) {
    return webcontainerOverride;
  }
  if (process === undefined) {
    return false;
  }
  // SAFETY: Node's process.versions is a string bag; WebContainer adds an optional key.
  const versions = process.versions as NodeJS.ProcessVersions & {
    webcontainer?: string;
  };
  return Boolean(versions.webcontainer);
};

/**
 * Runtimes where request context must survive on a sync fallback because
 * AsyncLocalStorage does not keep the store across `await` (WebContainer,
 * Cloudflare Workers / celld).
 */
export const needsSyncRequestStore = function needsSyncRequestStore(): boolean {
  if (syncRequestStoreOverride !== null) {
    return syncRequestStoreOverride;
  }
  if (inWebcontainer()) {
    return true;
  }
  // Cloudflare Workers / celld expose WebSocketPair; Node and Bun do not.
  // SAFETY: Workers add WebSocketPair on globalThis; missing means a non-Worker host.
  const workerApi = globalThis as typeof globalThis & {
    WebSocketPair?: object;
  };
  return workerApi.WebSocketPair !== undefined;
};

/** Test-only: force or clear the WebContainer detection path. */
export const __setInWebcontainerForTests = function __setInWebcontainerForTests(
  value: boolean | null
): void {
  webcontainerOverride = value;
};

/** Test-only: force or clear the sync request-store fallback path. */
export const __setNeedsSyncRequestStoreForTests =
  function __setNeedsSyncRequestStoreForTests(value: boolean | null): void {
    syncRequestStoreOverride = value;
  };

/** Module fallback when ALS does not survive awaits (WebContainer). */
let syncStore: ActionContext | null = null;

/** Serialize handler *entry* on WebContainer so syncStore is not stomped. */
let entryTail: Promise<null> = Promise.resolve(null);

const als = function als(): AsyncLocalStorage<ActionContext> {
  // SAFETY: ALS_KEY is oxide-owned; the slot is only ever AsyncLocalStorage<ActionContext>.
  const g = globalThis as typeof globalThis & {
    [ALS_KEY]?: AsyncLocalStorage<ActionContext>;
  };
  const existing = g[ALS_KEY];
  if (existing) {
    return existing;
  }
  const created = new AsyncLocalStorage<ActionContext>();
  g[ALS_KEY] = created;
  return created;
};

interface Thenable {
  then: (
    onfulfilled?:
      | ((value: OxidejsJson | undefined) => OxidejsJson | Thenable | undefined)
      | null,
    onrejected?:
      | ((
          reason: OxidejsJson | undefined
        ) => OxidejsJson | Thenable | undefined)
      | null
  ) => Thenable;
}

const isPromiseLike = function isPromiseLike(
  value: Thenable | null | undefined
): value is Thenable {
  if (value === null || value === undefined) {
    return false;
  }
  return typeof value.then === "function";
};

/** Current request context: ALS first, then the WebContainer sync fallback. */
export const getRequestStore = function getRequestStore(): ActionContext {
  const current = als().getStore() ?? syncStore;
  if (!current) {
    throw new Error("oxidejs: request context is unavailable");
  }
  return current;
};

/** Current store when inside a request, otherwise `undefined`. */
export const peekRequestStore = function peekRequestStore():
  | ActionContext
  | undefined {
  return als().getStore() ?? syncStore ?? undefined;
};

const store = function store(): ActionContext {
  return getRequestStore();
};

/**
 * Run `fn` with `store` on ALS and the sync fallback. When the runtime needs a
 * sync request store, restore only after an async `fn` settles (streams capture
 * the store at invoke time and re-enter via this helper on each pull). Sync
 * returns and throws restore immediately so a completed request is not left
 * visible.
 */
export const withRequestStore = function withRequestStore<T>(
  ctx: ActionContext,
  fn: () => T
): T {
  const previous = syncStore;
  syncStore = ctx;
  let deferRestore = false;
  try {
    const result = als().run(ctx, fn);
    // SAFETY: async handlers return Thenable; sync returns are not — only then defer restore.
    if (
      needsSyncRequestStore() &&
      isPromiseLike(result as Thenable | null | undefined)
    ) {
      deferRestore = true;
      // SAFETY: when result is Thenable, T is a Promise type; settle then restore syncStore.
      return (async () => {
        try {
          return await result;
        } finally {
          if (syncStore === ctx) {
            syncStore = previous;
          }
        }
      })() as T;
    }
    return result;
  } finally {
    if (!deferRestore) {
      syncStore = previous;
    }
  }
};

/**
 * Serialize request entry when the sync fallback is required.
 * WebContainer: hold the gate until `fn` settles.
 * Workers / celld: only serialize starts so long-lived streams do not block other actions.
 */
export const withRequestEntry = async function withRequestEntry<T>(
  fn: () => Promise<T>
): Promise<T> {
  if (!needsSyncRequestStore()) {
    return fn();
  }
  const { promise: gate, resolve: release } = Promise.withResolvers<null>();
  const previous = entryTail;
  entryTail = gate;
  await previous;
  if (!inWebcontainer()) {
    release(null);
    return await fn();
  }
  try {
    return await fn();
  } finally {
    release(null);
  }
};

/** Current RPC or host request context. Throws outside request handling. */
export const useCtx = function useCtx<
  C extends ActionContext = ActionContext,
>(): C {
  // SAFETY: callers narrow ActionContext via C; the runtime store is always ActionContext.
  return store() as C;
};

/** Current server `Request`. Available in actions, SSR, and frame renders. */
export const useRequest = function useRequest(): Request {
  return store().req;
};

/** Worker `env` from `fetch(request, env, ctx)`. `undefined` on the Node fetch preset. */
export const useEnv = function useEnv<E = { [key: string]: OxidejsJson }>():
  | E
  | undefined {
  // SAFETY: callers pick E; host env is a string-keyed binding bag stamped into ActionContext.
  return store().env as E | undefined;
};

/** Worker `ctx` from `fetch(request, env, ctx)` (`waitUntil`). `undefined` on Node. */
export const useFetchCtx = function useFetchCtx():
  | ExecutionContext
  | undefined {
  return store().fetchCtx;
};

/** Idempotency key from the client `CallOptions` / RPC headers, if present. */
export const useIdempotencyKey = function useIdempotencyKey():
  | string
  | undefined {
  return store().idempotencyKey;
};

export const runWithRequest = function runWithRequest<T>(
  req: Request,
  fn: () => T,
  extra?: Partial<ActionContext>
): T {
  return withRequestStore({ ...extra, req }, fn);
};
