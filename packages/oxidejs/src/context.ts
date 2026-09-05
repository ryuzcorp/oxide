import { AsyncLocalStorage } from "node:async_hooks";
import process from "node:process";

import type { OxidejsJson } from "./types";

const ALS_KEY = Symbol.for("oxidejs.requestContext");
const FETCH_KEY = Symbol.for("oxidejs.fetch");

export interface ExecutionContext {
  passThroughOnException?: () => void;
  waitUntil?: (
    promise: PromiseLike<OxidejsJson | object | null | undefined>
  ) => void;
}

/** Return from `src/server.ts` `fetch`. `undefined` falls through to assets. */
export type FetchResult = Response | undefined;

/**
 * `src/server.ts` fetch handler. The generated wrapper always calls
 * `fetch(request, env, ctx)` — `env` may be `{}` on Node without the `env` option.
 * Return `undefined` (or bare `return`) to fall through to assets.
 */
export type FetchHandler<Env extends object = { [key: string]: OxidejsJson }> =
  (
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ) => FetchResult | Promise<FetchResult>;

/** Default export shape for `src/server.ts`. */
export interface ServerEntry<
  Env extends object = { [key: string]: OxidejsJson },
> {
  fetch: FetchHandler<Env>;
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
}

/** Override for tests. `null` uses `process.versions.webcontainer`. */
let webcontainerOverride: boolean | null = null;

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

/** Test-only: force or clear the WebContainer detection path. */
export const __setInWebcontainerForTests = function __setInWebcontainerForTests(
  value: boolean | null
): void {
  webcontainerOverride = value;
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

const store = function store(): ActionContext {
  return getRequestStore();
};

/**
 * Run `fn` with `store` on ALS and the sync fallback. On WebContainer the sync
 * slot is restored only after an async `fn` settles (streams capture the store
 * at invoke time and re-enter via this helper on each pull). Sync returns and
 * throws restore immediately so a completed request is not left visible.
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
      inWebcontainer() &&
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
 * Serialize async work that installs request context on WebContainer.
 * Release as soon as `fn` settles — do not wait for streamed response bodies.
 */
export const withRequestEntry = async function withRequestEntry<T>(
  fn: () => Promise<T>
): Promise<T> {
  if (!inWebcontainer()) {
    return fn();
  }
  const { promise: gate, resolve: release } = Promise.withResolvers<null>();
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

export const runWithRequest = function runWithRequest<T>(
  req: Request,
  fn: () => T,
  extra?: Partial<ActionContext>
): T {
  return withRequestStore({ ...extra, req }, fn);
};

type RequestStoreHook = <T>(req: Request, fn: () => T) => T;

const HOOK_KEY = Symbol.for("oxidejs.runWithRequest");
// SAFETY: HOOK_KEY is oxide-owned; the slot is only ever RequestStoreHook.
const hookGlobal = globalThis as typeof globalThis & {
  [HOOK_KEY]?: RequestStoreHook;
};
hookGlobal[HOOK_KEY] ??= function oxideRunWithRequest<T>(
  req: Request,
  fn: () => T
): T {
  // SAFETY: fetch host stamps Partial<ActionContext> on Request under FETCH_KEY before dispatch.
  const stamped = req as Request & { [FETCH_KEY]?: Partial<ActionContext> };
  return runWithRequest(req, fn, stamped[FETCH_KEY]);
};

export {
  action,
  brandServerAction,
  wrapClientRpc,
  wrapClientStreamRpc,
  ACTION_CALL,
} from "./action";
export type { ServerActionHandle, StreamActionHandle } from "./action";
