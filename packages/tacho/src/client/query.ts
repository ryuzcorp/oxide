import { createProxyClient, type CallOptions, type RPCClient } from "../index";

/** Options for a cached call surface. */
export type QueryOptions = {
  /**
   * Custom cache key. Default is the RPC method path plus the input:
   * `["user.get", { id: "1" }]`.
   */
  key?: unknown[] | undefined;
  /** How long results stay fresh in ms. Default: forever, until invalidated. */
  staleTime?: number | undefined;
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

export type QueryCacheApi = {
  /** Drop matching cache entries. With `{ refetch: true }`, re-run them from the wire. */
  invalidate(match?: InvalidateMatch, opts?: { refetch?: boolean }): Promise<void>;
  /** Drop everything. */
  clear(): void;
  /** Keys of cached entries. Order is unspecified. */
  keys(): unknown[][];
};

/** `.query()` / `.cache` surface added on top of a plain RPC client. */
export type QueryExtras<R> = {
  query: (opts?: QueryOptions) => RPCClient<R>;
  cache: QueryCacheApi;
};

type Entry = {
  key: unknown[];
  method: string;
  params: unknown;
  customKey?: boolean | undefined;
  value?: unknown;
  freshUntil: number;
  inflight: Promise<unknown> | undefined;
};

const FRESH = Symbol("tacho-query-fresh");

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
  return match({ method: entry.method, params: entry.params, key: entry.key });
};

// Files, Blobs, and class instances have no stable JSON identity.
const hashableParams = (params: unknown): string | undefined => {
  try {
    return params === undefined ? "" : hashable(params);
  } catch {
    return undefined;
  }
};

type RunOptions = { key?: unknown[] | undefined; staleTime?: number | undefined };

/**
 * Wraps a send function with a method-path-keyed cache and produces the
 * `.query()` / `.cache` client extras.
 *
 * Keying: `[method, input]` by default, hashed stably so key order in object
 * inputs does not matter. Failures are never cached beyond in-flight dedup: a
 * rejected call drops its entry so the next call retries. Streams and
 * non-JSON-safe inputs bypass the cache entirely.
 */
export function createQueryExtras<R>(
  send: (method: string, params: unknown, opts?: CallOptions) => Promise<unknown>,
): QueryExtras<R> {
  const store = new Map<string, Entry>();

  const run = async (
    method: string,
    params: unknown,
    opts: RunOptions,
    call?: CallOptions,
  ): Promise<unknown> => {
    // Non-JSON-safe input (files, blobs) -> no stable key, no caching.
    const autoHash = opts.key ? undefined : hashableParams(params);
    if (!opts.key && autoHash === undefined) return send(method, params, call);

    const keyStr = opts.key ? JSON.stringify(opts.key) : `auto:${method}:${autoHash}`;

    let entry = store.get(keyStr);
    if (
      entry &&
      entry.value !== FRESH &&
      entry.inflight === undefined &&
      Date.now() >= entry.freshUntil
    )
      store.delete(keyStr); // past its fresh window: drop old result, refetch below
    entry = store.get(keyStr);

    if (entry?.inflight) return entry.inflight;
    if (entry && entry.value !== FRESH && Date.now() < entry.freshUntil) return entry.value;

    const key = opts.key ?? ([method, ...(params === undefined ? [] : [params])] as unknown[]);
    const p = send(method, params, call).then((result) => {
      const prev = store.get(keyStr);
      // Streams come back as AsyncGenerators from this same await: not cacheable.
      if (!(result && typeof result === "object" && Symbol.asyncIterator in result)) {
        if (prev?.inflight === p)
          store.set(keyStr, {
            key,
            method,
            params,
            customKey: !!opts.key,
            value: result,
            freshUntil: Date.now() + (opts.staleTime ?? Number.POSITIVE_INFINITY),
            inflight: undefined,
          });
      }
      return result;
    });
    // Both branches settle the in-flight slot; a bare .finally() would derive
    // an unhandled rejected promise on every failed call.
    p.then(
      () => {
        const cur = store.get(keyStr);
        if (cur?.inflight === p) cur.inflight = undefined;
      },
      () => {
        const cur = store.get(keyStr);
        if (cur?.inflight === p) {
          cur.inflight = undefined;
          if (cur.value === FRESH) store.delete(keyStr); // failed call: allow retry
        }
      },
    );
    store.set(keyStr, {
      key,
      method,
      params,
      value: FRESH,
      freshUntil: 0,
      inflight: p,
    });
    return p;
  };

  const invalidate = async (match?: InvalidateMatch, opts?: { refetch?: boolean }) => {
    const targets = [...store.entries()].filter(([, e]) => !e.inflight && matches(e, match));
    for (const [k] of targets) store.delete(k);
    if (!opts?.refetch) return;
    for (const [, e] of targets)
      await run(e.method, e.params, {
        // Auto-keyed entries must recompute their hashable key, not reuse raw params.
        key: e.customKey ? e.key : undefined,
        staleTime: Number.POSITIVE_INFINITY,
      });
  };

  return {
    query: (opts?: QueryOptions) =>
      createProxyClient<R>((method, params, call) => run(method, params, opts ?? {}, call)),
    cache: {
      invalidate,
      clear: () => store.clear(),
      keys: () => [...store.values()].map((e) => e.key),
    },
  };
}
