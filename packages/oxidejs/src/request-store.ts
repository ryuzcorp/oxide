import { AsyncLocalStorage } from "node:async_hooks";
import process from "node:process";

import { deferred } from "./deferred";
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

/** `process.versions` as a host may shape it: a real WebContainer sets a string. */
export interface WebcontainerVersions {
  readonly [key: string]: string | (() => void) | undefined;
}

/**
 * True only for a real WebContainer version string. celld's `node:process`
 * answers every unknown `versions` key with a stub function, so a truthiness
 * check reads celld as a WebContainer and serializes every action behind one
 * cross-request gate.
 */
export const isWebcontainerVersions = function isWebcontainerVersions(
  versions: WebcontainerVersions
): boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- host probe: celld answers unknown keys with a function
  return typeof versions["webcontainer"] === "string";
};

/** StackBlitz WebContainers lose AsyncLocalStorage across `async/await`. */
export const inWebcontainer = function inWebcontainer(): boolean {
  if (webcontainerOverride !== null) {
    return webcontainerOverride;
  }
  if (process === undefined) {
    return false;
  }
  return isWebcontainerVersions(process.versions);
};

/**
 * Runtimes where request context must survive on a sync fallback because
 * AsyncLocalStorage does not keep the store across `await`: WebContainer
 * only. Workers and celld need `nodejs_compat` (or `nodejs_als`) to import
 * `node:async_hooks` at all, and there AsyncLocalStorage keeps the store
 * across `await` (measured on celld 0.6.0). A module-global fallback on those
 * hosts would hand one request's context to a concurrent request whenever
 * the ALS store is empty.
 */
export const needsSyncRequestStore = function needsSyncRequestStore(): boolean {
  if (syncRequestStoreOverride !== null) {
    return syncRequestStoreOverride;
  }
  return inWebcontainer();
};

/** Module fallback when ALS does not survive awaits (WebContainer). */
let syncStore: ActionContext | null = null;

/** Serialize handler *entry* on WebContainer so syncStore is not stomped. */
let entryTail: Promise<null> = Promise.resolve(null);

/**
 * A test that switches the host mode starts from an empty fallback: an
 * earlier test's action that never settled (an open stream) would otherwise
 * leave its context in the module slot.
 */
const resetSyncFallbackForTests = function resetSyncFallbackForTests(): void {
  syncStore = null;
  entryTail = Promise.resolve(null);
};

/** Test-only: force or clear the WebContainer detection path. */
export const __setInWebcontainerForTests = function __setInWebcontainerForTests(
  value: boolean | null
): void {
  webcontainerOverride = value;
  resetSyncFallbackForTests();
};

/** Test-only: force or clear the sync request-store fallback path. */
export const __setNeedsSyncRequestStoreForTests =
  function __setNeedsSyncRequestStoreForTests(value: boolean | null): void {
    syncRequestStoreOverride = value;
    resetSyncFallbackForTests();
  };

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

/**
 * Install the Worker / WebContainer sync fallback store. Returns the previous
 * value for {@link exitRequestStore}. Prefer {@link withRequestStore} for
 * Promise handlers; Effect handlers need this pair so the store survives the
 * whole fiber (codegen must not clear it when `fn` returns an Effect).
 */
export const enterRequestStore = function enterRequestStore(
  ctx: ActionContext
): ActionContext | null {
  const previous = syncStore;
  // Only where ALS cannot carry the store: a module-global slot elsewhere
  // could hand this context to a concurrent request, and an interrupted
  // action that never reaches its exit would leave it set for good.
  if (needsSyncRequestStore()) {
    syncStore = ctx;
  }
  return previous;
};

/** Restore sync fallback after {@link enterRequestStore}, if still ours. */
export const exitRequestStore = function exitRequestStore(
  ctx: ActionContext,
  previous: ActionContext | null
): void {
  if (syncStore === ctx) {
    syncStore = previous;
  }
};

/** The sync fallback store, only on hosts that need it. */
const syncFallback = function syncFallback(): ActionContext | null {
  return needsSyncRequestStore() ? syncStore : null;
};

/** Run `fn` under ALS for `ctx` (does not touch the sync fallback). */
export const runWithAls = function runWithAls<T>(
  ctx: ActionContext,
  fn: () => T
): T {
  return als().run(ctx, fn);
};

/** Current request context: ALS first, then the WebContainer sync fallback. */
export const getRequestStore = function getRequestStore(): ActionContext {
  const current = als().getStore() ?? syncFallback();
  if (!current) {
    throw new Error("oxidejs: request context is unavailable");
  }
  return current;
};

/** Current store when inside a request, otherwise `undefined`. */
export const peekRequestStore = function peekRequestStore():
  | ActionContext
  | undefined {
  return als().getStore() ?? syncFallback() ?? undefined;
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
  if (!needsSyncRequestStore()) {
    return als().run(ctx, fn);
  }
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
 * Serialize request entry on WebContainer: hold the gate until `fn` settles so
 * the sync store is not stomped. Every other host runs `fn` directly. On a
 * Worker host the gate would chain each request to the one before it, and a
 * request the host cancels mid-wait (celld drops a finished or aborted
 * request's pending work) never releases its link, which stalls every action
 * after it.
 */
export const withRequestEntry = async function withRequestEntry<T>(
  fn: () => Promise<T>
): Promise<T> {
  if (!inWebcontainer()) {
    return fn();
  }
  const { promise: gate, resolve: release } = deferred<null>();
  const previous = entryTail;
  entryTail = gate;
  await previous;
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

/** Worker `env` from `fetch(request, env, ctx)`. `undefined` on Node. */
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

const derivedIdCounts = new WeakMap<ActionContext, number>();

/**
 * A distinct, deterministic id for the next queue message or workflow start
 * of the current keyed request, or `undefined` outside a request or without a
 * key. The first call keeps the key; later calls get `key:1`, `key:2`, … So a
 * retried RPC call (same key, same code path) reproduces the same ids, while
 * two sends in one action no longer share one id and collapse into one
 * workflow instance.
 */
export const nextRequestScopedId = function nextRequestScopedId():
  | string
  | undefined {
  const current = peekRequestStore();
  const key = current?.idempotencyKey;
  if (!(current && key)) {
    return undefined;
  }
  const count = derivedIdCounts.get(current) ?? 0;
  derivedIdCounts.set(current, count + 1);
  return count === 0 ? key : `${key}:${count}`;
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
