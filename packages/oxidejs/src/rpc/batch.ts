/**
 * Client-side JSON-RPC 2.0 batching for action calls.
 *
 * The HTTP client protocol queues each unary request here instead of POSTing it
 * immediately. `batch()` flushes the queue as one JSON-RPC 2.0 batch (`[req, …]`)
 * so N calls cost one round trip. Calls that are never batched flush on their own,
 * one request each, exactly as before.
 *
 * State lives on `globalThis` under a `Symbol.for` key so the client transport
 * (`oxidejs/rpc/client`) and `batch` (exported from `oxidejs`) share it even when
 * a bundler emits them as separate copies.
 */

/** An HTTP client transport that can post its queued requests as one batch. */
export interface BatchFlusher {
  /** POST every queued request as a single JSON-RPC 2.0 batch. */
  flush: () => Promise<void>;
  /** Requests queued but not posted yet. */
  queued: () => number;
}

/** Action result as it crosses RPC: JSON-ish data, plus `undefined` for void. */
export type BatchValue = object | string | number | boolean | null | undefined;

/**
 * A zero-arg action handle, or a thunk that starts a call with arguments.
 * Parameter lists are compared contravariantly, so `() => R` accepts handles
 * declared as `(...args: [] | [CallOptions]) => R`.
 */
export type BatchCall = () => BatchValue | PromiseLike<BatchValue>;

/** A pending action call, or a thunk that starts one. */
export type BatchItem = PromiseLike<BatchValue> | BatchCall;

/** Awaited results of `batch()` items, in call order. */
export type BatchResult<Items extends readonly BatchValue[]> = {
  -readonly [K in keyof Items]: Items[K] extends () => infer R
    ? Awaited<R>
    : Awaited<Items[K]>;
};

interface BatchState {
  /** Live `batch()` calls collecting requests; automatic flush yields while > 0. */
  collectors: number;
  flushers: Set<BatchFlusher>;
  scheduled: boolean;
}

/** Microtask hops to wait for queued sends before flushing anyway (~microseconds). */
const FLUSH_TICKS = 32;

const BATCH_KEY = Symbol.for("oxidejs.batch");
// SAFETY: BATCH_KEY is oxide-owned; the slot only ever holds BatchState.
const globalScope = globalThis as typeof globalThis & {
  [BATCH_KEY]?: BatchState;
};
const state: BatchState = globalScope[BATCH_KEY] ?? {
  collectors: 0,
  flushers: new Set(),
  scheduled: false,
};
globalScope[BATCH_KEY] = state;

/** Register a transport whose queue `batch()` can flush. Returns an unregister. */
export const registerBatchFlusher = function registerBatchFlusher(
  flusher: BatchFlusher
): () => void {
  state.flushers.add(flusher);
  return () => {
    state.flushers.delete(flusher);
  };
};

const queuedRequests = function queuedRequests(): number {
  let total = 0;
  for (const flusher of state.flushers) {
    total += flusher.queued();
  }
  return total;
};

const flushQueued = async function flushQueued(): Promise<void> {
  state.scheduled = false;
  await Promise.all([...state.flushers].map((flusher) => flusher.flush()));
};

/**
 * Queue an automatic flush for the next microtask. Skipped while a `batch()` is
 * collecting so its own flush owns the queued requests.
 */
export const scheduleBatchFlush = function scheduleBatchFlush() {
  if (state.scheduled) {
    return;
  }
  state.scheduled = true;
  queueMicrotask(() => {
    state.scheduled = false;
    if (state.collectors > 0) {
      return;
    }
    void flushQueued();
  });
};

/** Wait until every expected request has reached a transport queue. */
const waitForQueued = async function waitForQueued(
  expected: number
): Promise<void> {
  for (let tick = 0; tick < FLUSH_TICKS; tick += 1) {
    if (queuedRequests() >= expected) {
      return;
    }
    // Sequential hops: each send lands on its own microtask turn.
    // oxlint-disable-next-line eslint/no-await-in-loop -- ordered microtask hops
    await Promise.resolve();
  }
};

const isAsyncIterable = function isAsyncIterable(
  value: unknown
): value is AsyncIterable<BatchValue> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  // SAFETY: narrowed to object; probe the optional async iterator method.
  const probe = value as { [Symbol.asyncIterator]?: unknown };
  return typeof probe[Symbol.asyncIterator] === "function";
};

const isThenable = function isThenable(
  value: unknown
): value is PromiseLike<BatchValue> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  // SAFETY: narrowed to object; probe the optional then method.
  const probe = value as { then?: unknown };
  return typeof probe.then === "function";
};

const isCall = function isCall(item: BatchItem): item is BatchCall {
  return typeof item === "function";
};

const startCall = function startCall(item: BatchItem): PromiseLike<BatchValue> {
  // Zero-arg handles and thunks are callable; pending calls are not.
  const value = isCall(item) ? item() : item;
  if (isAsyncIterable(value)) {
    throw new TypeError(
      "oxidejs: batch() does not support stream actions — call them directly"
    );
  }
  if (isThenable(value)) {
    return value;
  }
  throw new TypeError("oxidejs: batch() items must be action calls or thunks");
};

/**
 * Observe a call so a rejection while the batch is in flight is never reported
 * as unhandled. The batch result still rejects through `Promise.all`.
 */
const observeCall = async function observeCall(
  call: PromiseLike<BatchValue>
): Promise<void> {
  try {
    await call;
  } catch {
    // Rewritten as the batch rejection; swallow only the duplicate report.
  }
};

/**
 * Run action calls as one JSON-RPC 2.0 batch request.
 *
 * Items are pending calls (`batch(fetchOne(1), fetchTwo(2))`) or thunks that
 * start one (`batch(() => fetchOne(1), fetchTwo)`); a single array argument is
 * accepted too. Calls must be created in the same tick as `batch()`. Results
 * resolve in call order; a rejected call rejects the returned promise.
 *
 * Without an HTTP transport (`transport: "ws"`) the calls run as usual — one
 * message each — since batching is a JSON-RPC 2.0 HTTP transport feature.
 * On the server (and SSR) the same calls run locally, in parallel.
 */
export function batch<const Items extends readonly BatchItem[]>(
  items: Items
): Promise<BatchResult<Items>>;
export function batch<const Items extends readonly BatchItem[]>(
  ...items: Items
): Promise<BatchResult<Items>>;
export async function batch(
  ...rawItems: (BatchItem | BatchItem[])[]
): Promise<BatchValue[]> {
  const items: BatchItem[] = [];
  for (const entry of rawItems) {
    if (Array.isArray(entry)) {
      items.push(...entry);
    } else {
      items.push(entry);
    }
  }

  const calls: PromiseLike<BatchValue>[] = [];
  state.collectors += 1;
  try {
    for (const item of items) {
      calls.push(startCall(item));
    }
    for (const call of calls) {
      void observeCall(call);
    }
    if (calls.length > 0 && state.flushers.size > 0) {
      await waitForQueued(calls.length);
      await flushQueued();
    }
  } finally {
    state.collectors -= 1;
  }
  // Requests that landed after our flush still need their own POST.
  scheduleBatchFlush();
  return await Promise.all(calls);
}
