import { createProxyClient, type CallOptions, type RPCClient } from "../index";

/** Options for a cached call surface. */
export type QueryOptions = {
  /**
   * Custom cache key prefix. Default for RPC clients is the method path;
   * default for wrapped functions is a session identity plus the arguments.
   */
  key?: unknown[] | undefined;
  /** How long results stay fresh in ms. Default: forever, until invalidated. */
  staleTime?: number | undefined;
  /** A shared, optionally persistent cache returned by {@link createCache}. */
  cache?: CacheHandle | undefined;
};

export type CacheEntryInfo = {
  method: string;
  params: unknown;
  key: unknown[];
};

/**
 * Invalidation scoping:
 * - omitted -> everything
 * - string or string[] -> matches entries whose stored key starts with those segments
 * - function -> predicate over each entry
 */
export type InvalidateMatch = string | string[] | ((entry: CacheEntryInfo) => boolean) | undefined;

/** Minimal storage contract for {@link createCache}. Values are JSON strings. */
export type CacheDriver = {
  keys(): string[] | Promise<string[]>;
  get(key: string): string | undefined | Promise<string | undefined>;
  set(key: string, value: string): void | Promise<void>;
  delete(key: string): void | Promise<void>;
};

/** Storage adapter over Web Storage (`localStorage` / `sessionStorage`). */
export function localStorageDriver(storage?: Storage): CacheDriver {
  return {
    keys: () => {
      const s = storageOf(storage);
      const out: string[] = [];
      for (let i = 0; i < s.length; i++) out.push(s.key(i)!);
      return out;
    },
    get: (key) => storageOf(storage).getItem(key) ?? undefined,
    set: (key, value) => void storageOf(storage).setItem(key, value),
    delete: (key) => void storageOf(storage).removeItem(key),
  };
}

function storageOf(storage?: Storage): Storage {
  const s = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  if (!s)
    throw new Error("tacho: localStorage is unavailable; pass a Storage or a custom CacheDriver");
  return s;
}

export type QueryCacheApi = {
  /** Drop matching cache entries. With `{ refetch: true }`, re-run them from the wire. */
  invalidate(match?: InvalidateMatch, opts?: { refetch?: boolean }): Promise<void>;
  /** Drop everything. */
  clear(): void;
  /** Keys of cached entries. Order is unspecified. */
  keys(): unknown[][];
};

const FRESH = Symbol("tacho-query-fresh");
const HANDLE = Symbol("tacho-cache-handle");

type Entry = {
  /** Key identity without the hashed args: rebuilt verbatim on refetch. */
  baseKey: unknown[];
  /** Human-facing key including the raw params. */
  key: unknown[];
  params: unknown;
  value?: unknown;
  freshUntil: number;
  inflight: Promise<unknown> | undefined;
  /** Re-run closure captured at call time. Hydrated entries have none, so they cannot be refetched automatically. */
  redo?: (() => Promise<unknown>) | undefined;
};

type RunOptions = { key?: unknown[] | undefined; staleTime?: number | undefined };

type PersistedEnvelope = {
  b: unknown[];
  p: unknown;
  v: unknown;
  /** Fresh window end in epoch ms, or null for "never stale". */
  f: number | null;
};

const hashable = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(hashable).join(",")}]`;
  const obj = v as Record<string, unknown>;
  if (Object.getPrototypeOf(obj) !== Object.prototype) throw new RangeError("unhashable");
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${hashable(obj[k])}`)
    .join(",")}}`;
};

// Files, Blobs, and class instances have no stable JSON identity.
const hashableOf = (params: unknown): string | undefined => {
  try {
    return params === undefined ? "" : hashable(params);
  } catch {
    return undefined;
  }
};

const segmentPrefix = (key: unknown[], match: unknown[]) => {
  if (match.length === 0) return true;
  if (match.length > key.length) return false;
  let i = 0;
  while (i < match.length && String(key[i]) === String(match[i])) i++;
  return i === match.length;
};

const matches = (entry: Entry, match: InvalidateMatch): boolean => {
  if (match === undefined) return true;
  if (typeof match === "string") return segmentPrefix(entry.key, [match]);
  if (Array.isArray(match)) return segmentPrefix(entry.key, match);
  return match({ method: String(entry.key[0]), params: entry.params, key: entry.key });
};

/**
 * Shared result store: string-keyed entries with in-flight dedup, stale
 * windows, and never-cached failures. Both the client extras (method-path
 * keys) and standalone wrapped functions run on this.
 *
 * Cache key layout: every lookup is `JSON.stringify([...baseKey, argsHash])`,
 * so object key order never matters and equal-args calls share one slot.
 *
 * With a driver, settled values are written through as namespaced JSON
 * envelopes and hydrated once up front. Values that cannot survive
 * JSON round-trips (File, Blob, class instances) are simply not persisted.
 */
function createStore(bundleOpts?: { ns?: string; driver?: CacheDriver }) {
  const prefix = bundleOpts?.ns ? `${bundleOpts.ns}:` : "";
  const driver = bundleOpts?.driver;
  const store = new Map<string, Entry>();
  // Hydration completes before any lookup reads stale-but-present data.
  const hydrated = driver
    ? (async () => {
        const fullKeys = await driver.keys();
        for (const fullKey of fullKeys) {
          if (!fullKey.startsWith(prefix)) continue;
          const raw = await driver.get(fullKey);
          if (!raw) continue;
          let env: PersistedEnvelope;
          try {
            env = JSON.parse(raw) as PersistedEnvelope;
            if (!Array.isArray(env.b)) continue;
          } catch {
            continue; // foreign or corrupt data: pretend it does not exist
          }
          const freshUntil = env.f ?? Number.POSITIVE_INFINITY;
          if (Date.now() >= freshUntil) continue; // stale on arrival: ignore
          store.set(fullKey.slice(prefix.length), {
            baseKey: env.b,
            key: [...env.b, ...(env.p === undefined ? [] : [env.p])],
            params: env.p,
            value: env.v,
            freshUntil,
            inflight: undefined,
            redo: undefined,
          });
        }
      })()
    : undefined;

  const forget = (keyStr: string) => {
    store.delete(keyStr);
    if (driver) void driver.delete(`${prefix}${keyStr}`);
  };

  const settle = (p: Promise<unknown>, keyStr: string) => {
    void p.then(
      () => {
        const cur = store.get(keyStr);
        if (cur?.inflight === p) cur.inflight = undefined;
      },
      () => {
        const cur = store.get(keyStr);
        if (cur?.inflight === p) {
          cur.inflight = undefined;
          if (cur.value === FRESH) forget(keyStr); // failed call: allow retry
        }
      },
    );
  };

  const run = async (
    baseKey: unknown[],
    params: unknown,
    fetcher: () => Promise<unknown>,
    opts: RunOptions,
  ): Promise<unknown> => {
    // Non-JSON-safe input (files, blobs) -> no stable hash, no caching.
    const argsHash = hashableOf(params);
    if (argsHash === undefined) return fetcher();
    if (hydrated) await hydrated;

    const keyStr = JSON.stringify([...baseKey, argsHash]);

    let entry = store.get(keyStr);
    if (
      entry &&
      entry.value !== FRESH &&
      entry.inflight === undefined &&
      Date.now() >= entry.freshUntil
    )
      forget(keyStr); // past its fresh window: drop old result, refetch below
    entry = store.get(keyStr);

    if (entry?.inflight) return entry.inflight;
    if (entry && entry.value !== FRESH && Date.now() < entry.freshUntil) return entry.value;

    const capture = {
      baseKey,
      key: [...baseKey, ...(params === undefined ? [] : [params])],
      params,
      redo: fetcher,
    };
    const p = fetcher().then((result) => {
      const prev = store.get(keyStr);
      // Streams come back as AsyncGenerators from this same await: not cacheable.
      if (!(result && typeof result === "object" && Symbol.asyncIterator in result)) {
        if (prev?.inflight === p) {
          const settled: Entry = {
            ...capture,
            value: result,
            freshUntil: Date.now() + (opts.staleTime ?? Number.POSITIVE_INFINITY),
            inflight: undefined,
          };
          store.set(keyStr, settled);
          if (driver) {
            try {
              const env: PersistedEnvelope = {
                b: settled.baseKey,
                p: settled.params,
                v: settled.value,
                f: settled.freshUntil === Number.POSITIVE_INFINITY ? null : settled.freshUntil,
              };
              void driver.set(`${prefix}${keyStr}`, JSON.stringify(env));
            } catch {
              // Not representable in JSON: memory-only.
            }
          }
        }
      }
      return result;
    });
    // Settle the in-flight slot; a bare .finally() would derive an unhandled
    // rejected promise on every failed call.
    settle(p, keyStr);
    store.set(keyStr, { ...capture, value: FRESH, freshUntil: 0, inflight: p });
    return p;
  };

  const api = (): QueryCacheApi => ({
    async invalidate(match?: InvalidateMatch, opts?: { refetch?: boolean }) {
      if (hydrated) await hydrated;
      const targets = [...store.entries()].filter(([, e]) => !e.inflight && matches(e, match));
      for (const [k] of targets) forget(k);
      if (!opts?.refetch) return;
      for (const [, e] of targets) {
        if (!e.redo) continue; // hydrated entry: no replay closure available
        await run(e.baseKey, e.params, e.redo, { staleTime: Number.POSITIVE_INFINITY });
      }
    },
    clear: () => {
      for (const k of store.keys()) forget(k);
    },
    keys: () => [...store.values()].map((e) => e.key),
  });

  return { run, api };
}

type StoreBundle = ReturnType<typeof createStore>;

const HANDLE_BUNDLE = new WeakMap<object, StoreBundle>();

/** Internal: resolve (or lazily build) the store backing an options object. */
const bundleFor = (opts?: { cache?: CacheHandle | undefined }): StoreBundle =>
  (opts?.cache && HANDLE_BUNDLE.get(opts.cache)) || createStore();

/** `.query()` / `.cache` surface added on top of a plain RPC client. */
export type QueryExtras<R> = {
  query: (opts?: QueryOptions) => RPCClient<R>;
  cache: QueryCacheApi;
};

export function createQueryExtras<R>(
  send: (method: string, params: unknown, opts?: CallOptions) => Promise<unknown>,
  shared?: CacheHandle,
): QueryExtras<R> {
  const own = (shared && HANDLE_BUNDLE.get(shared)) || createStore();
  return {
    query: (opts?: QueryOptions) => {
      // A custom key namespaces every call made through this surface, e.g.
      // query({ key: ["user"] }).list() caches under ["user", "list", hash(input)].
      const prefix = opts?.key ?? [];
      const { run } = (opts?.cache && HANDLE_BUNDLE.get(opts.cache)) || own;
      return createProxyClient<R>((method, params, call) =>
        run([...prefix, method], params, () => send(method, params, call), opts ?? {}),
      );
    },
    // A client built over a shared handle surfaces that handle's API directly,
    // so invalidations route through the same store its calls write to.
    cache: shared ?? own.api(),
  };
}

/**
 * A named, sharable, optionally persistent cache. Pass it to `query(fn, ...)`
 * or HTTP clients so they share one store — invalidation against the handle
 * hits every consumer, and a driver makes results survive reloads.
 */
export type CacheHandle = QueryCacheApi;

/**
 * Creates a cache handle backed by your driver. Multiple surfaces can share one
 * handle; give them explicit `key` prefixes so cross-surface invalidation stays
 * meaningful.
 *
 * ```ts
 * const cache = createCache({ name: "myapp", driver: localStorageDriver() });
 * const listTasks = query(listTasksRaw, { cache, key: ["tasks"] });
 * await cache.invalidate(["tasks"]);
 * ```
 */
export function createCache(opts?: { name?: string; driver?: CacheDriver }): CacheHandle {
  const bundle = createStore(opts);
  const handle = Object.assign(bundle.api(), { [HANDLE]: bundle }) as CacheHandle & {
    [HANDLE]: StoreBundle;
  };
  HANDLE_BUNDLE.set(handle, bundle);
  return handle;
}

let wrapSeq = 0;

/**
 * Memoizes an async function — tacho server action stubs included.
 *
 * ```ts
 * import { query } from "tacho";
 * import { getUser } from "./users.server";
 *
 * const getUserCached = query(getUser, { staleTime: 30_000 });
 * await getUserCached({ id: "1" }); // deduped + cached per distinct input
 * await getUserCached.invalidate(); // drop every cached input of this function
 * ```
 *
 * The default cache identity ties to this wrapper instance plus a stable hash
 * of the arguments. Pass `{ key: ["users"] }` to pin the invalidation scope
 * explicitly. Streams bypass the cache; failures are never cached.
 */
export function query<A extends unknown[], T>(
  fn: (...args: A) => Promise<T>,
  opts?: QueryOptions,
): ((...args: A) => Promise<T>) & {
  /** Drop cached entries; pass a predicate over the call args to filter. */
  invalidate(match?: (info: { args: A }) => boolean): void;
  clear(): void;
} {
  // Session-unique namespace keeps unrelated wrappers apart even without an
  // explicit key. Explicit keys take precedence and stay stable across reloads.
  const selfBase = `fn#${++wrapSeq}`;
  const bundle = bundleFor(opts);
  const impl = (...args: A): Promise<T> =>
    bundle.run(
      opts?.key ? [...opts.key] : [selfBase],
      args,
      () => fn(...args),
      opts ?? {},
    ) as Promise<T>;
  return Object.assign(impl, {
    invalidate: (match?: (info: { args: A }) => boolean) =>
      void bundle
        .api()
        .invalidate(
          match
            ? (e) => match({ args: (Array.isArray(e.params) ? e.params : [e.params]) as A })
            : undefined,
        ),
    clear: () => void bundle.api().clear(),
  });
}
