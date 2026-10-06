import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { deferred } from "./deferred";

const TRANSIENT_CLOSE = /\b(?:1000|1001|1006)\b/u;
/** Brand written by `action()` / `brandServerAction`; `Symbol.for` so copies agree. */
const ACTION_KEY = Symbol.for("oxidejs.actionKey");
const DEFAULT_DB_NAME = "oxidejs-mutation-queue";
const DB_STORE = "mutations";

const isTransientFailure = function isTransientFailure(error: Error) {
  const chunks: string[] = [];
  let current: Error | undefined = error;
  const seen = new Set<Error>();
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    chunks.push(current.name, current.message);
    const nested: unknown = current.cause;
    current = nested instanceof Error ? nested : undefined;
  }
  const text = chunks.join(" ");
  if (/SocketOpenError/u.test(text)) {
    return true;
  }
  if (/SocketCloseError/u.test(text) && TRANSIENT_CLOSE.test(text)) {
    return true;
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return true;
  }
  return /Failed to fetch|NetworkError|ECONNRESET|ECONNREFUSED/u.test(text);
};

const asError = function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
};

/** Erased wrap() return held until flush; typed back to R at the call site. */
export type MutationOutcome =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | readonly MutationOutcome[]
  | { readonly [key: string]: MutationOutcome };

interface ActionKeyCarrier {
  [ACTION_KEY]?: string;
}

/**
 * Durable form of one queued write: no closures, only structured-cloneable
 * data. A {@link MutationQueueStorage} adapter stores these records verbatim.
 */
export interface PersistedMutation {
  /** Queue id — also the `idempotencyKey` sent to the server on replay. */
  id: string;
  /** Stable action identity from `wrap(fn, { key })` or the handle's brand. */
  key: string;
  /** Call args, in order. Must survive `structuredClone`. */
  args: MutationOutcome[];
  /** `Date.now()` at enqueue. */
  createdAt: number;
  /** Monotonic enqueue order across sessions; the queue replays by `seq`. */
  seq: number;
}

/**
 * Where a mutation queue keeps failed writes so they survive a reload.
 * Implement `load` / `put` / `delete` over any durable store.
 */
export interface MutationQueueStorage {
  /** Every persisted record; order does not matter (the queue sorts by `seq`). */
  load: () => Promise<PersistedMutation[]>;
  /** Store one record, replacing the record with the same `id`. */
  put: (entry: PersistedMutation) => Promise<void>;
  /** Drop the record with `id`. Missing ids are not an error. */
  delete: (id: string) => Promise<void>;
}

type Runner = () => Promise<MutationOutcome>;
type RunnerFactory = (item: QueuedMutation) => Runner;

interface QueuedMutation {
  args: MutationOutcome[];
  createdAt: number;
  id: string;
  key: string | undefined;
  /** In-flight `storage.put`, awaited before the write attempt. */
  persisted: Promise<void> | undefined;
  reject: ((error: Error) => void) | undefined;
  resolve: ((value: MutationOutcome) => void) | undefined;
  restored: boolean;
  run: Runner | undefined;
  seq: number;
}

type RunnableMutation = QueuedMutation & { run: Runner };

export interface MutationQueueItem {
  args: MutationOutcome[];
  createdAt: number;
  id: string;
  /** Stable action identity when known. Restored items always carry one. */
  key?: string;
}

export type MutationQueueListener = (event: {
  error?: Error;
  item?: MutationQueueItem;
  pending: number;
  type: "enqueue" | "flush" | "success" | "error" | "restore" | "discard";
}) => void;

export interface WrapMutationOptions<Args extends unknown[]> {
  /** Stable id per logical write. Default: new UUID per call. */
  idempotencyKey?: (...args: Args) => string;
  /**
   * Stable action identity, by convention `"<file>.<fn>"` (`"tasks.add"`).
   * Required to persist: it is how a restored write finds its action again.
   * Defaults to the handle's `ACTION_KEY` brand when it has one.
   */
  key?: string;
}

export interface MutationQueue {
  readonly pending: number;
  /** Resolves once persisted writes have loaded. No storage: resolves immediately. */
  readonly ready: Promise<void>;
  flush: () => Promise<void>;
  subscribe: (listener: MutationQueueListener) => () => void;
  wrap: <Args extends unknown[], R>(
    fn: (...args: Args) => Promise<R>,
    options?: WrapMutationOptions<Args>
  ) => (...args: Args) => Promise<R>;
}

export interface CreateMutationQueueOptions {
  /**
   * Retries per queued item during `flush` (and optional pre-enqueue attempts).
   * Uses Effect `Schedule.exponential` + jitter. Default 4 retries after the
   * first attempt (5 tries total).
   */
  retries?: number;
  /** Base delay for exponential backoff. Default `50 millis`. */
  retryBase?: Duration.Input;
  /**
   * Durable storage for failed writes. Default (or `"memory"`): memory only,
   * nothing survives a reload. Pass {@link indexedDbStorage} in the browser, or
   * your own {@link MutationQueueStorage} adapter.
   */
  storage?: MutationQueueStorage | "memory";
}

const readActionKey = function readActionKey(
  target: ActionKeyCarrier
): string | undefined {
  return target[ACTION_KEY];
};

const toPublicItem = function toPublicItem(
  item: QueuedMutation
): MutationQueueItem {
  const publicItem: MutationQueueItem = {
    args: item.args,
    createdAt: item.createdAt,
    id: item.id,
  };
  if (item.key !== undefined) {
    publicItem.key = item.key;
  }
  return publicItem;
};

/**
 * A persisted record is this queue's own data, so decode it at the storage
 * boundary: a record this queue did not write is skipped.
 */
const PersistedMutationSchema = Schema.Struct({
  args: Schema.Array(Schema.Unknown),
  createdAt: Schema.Number,
  id: Schema.String,
  key: Schema.String,
  seq: Schema.Number,
});

const decodePersistedMutation = function decodePersistedMutation(
  record: PersistedMutation
): PersistedMutation | undefined {
  const decoded = Schema.decodeUnknownResult(PersistedMutationSchema)(record);
  if (Result.isFailure(decoded)) {
    return undefined;
  }
  // SAFETY: `wrap` only persists args that `structuredClone` accepted, so the
  // decoded array holds MutationOutcome values.
  return {
    ...decoded.success,
    args: decoded.success.args as MutationOutcome[],
  };
};

/**
 * Turn a queued item into its durable record. Throws before the write is
 * queued when the queue could not replay it: no stable key, or args that
 * `structuredClone` rejects.
 */
const persistEntry = function persistEntry(
  item: QueuedMutation
): PersistedMutation {
  if (item.key === undefined) {
    throw new Error(
      `oxidejs: mutation queue storage needs a stable action key for "${item.id}"; pass wrap(fn, { key: "tasks.add" }) so a restored write can find its action`
    );
  }
  let args: MutationOutcome[];
  try {
    // SAFETY: structuredClone returns the cloneable subset of MutationOutcome.
    args = structuredClone(item.args) as MutationOutcome[];
  } catch (error) {
    throw new Error(
      `oxidejs: mutation queue storage needs structured-cloneable args for "${item.key}"; drop \`storage\` or pass plain data`,
      { cause: error }
    );
  }
  return {
    args,
    createdAt: item.createdAt,
    id: item.id,
    key: item.key,
    seq: item.seq,
  };
};

const transientRetry = function transientRetry(
  retries: number,
  base: Duration.Input
) {
  return {
    schedule: Schedule.exponential(base).pipe(Schedule.jittered),
    times: retries,
    while: (error: Error) => isTransientFailure(error),
  };
};

const isRunnable = function isRunnable(
  candidate: QueuedMutation
): candidate is RunnableMutation {
  return candidate.run !== undefined;
};

const dbCache = new Map<string, Promise<IDBDatabase>>();

const openDatabase = function openDatabase(name: string): Promise<IDBDatabase> {
  // oxlint-disable-next-line promise/avoid-new -- IndexedDB open callbacks
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "id" });
      }
    });
    request.addEventListener("success", () => {
      resolve(request.result);
    });
    request.addEventListener("error", () => {
      reject(
        request.error ??
          new Error(`oxidejs: could not open IndexedDB "${name}"`)
      );
    });
    request.addEventListener("blocked", () => {
      reject(
        new Error(`oxidejs: IndexedDB "${name}" is blocked by another tab`)
      );
    });
  });
};

/** Drop an open that failed (private mode, blocked upgrade) so it can retry. */
const forgetFailedOpen = async function forgetFailedOpen(
  name: string,
  opening: Promise<IDBDatabase>
): Promise<void> {
  try {
    await opening;
  } catch {
    dbCache.delete(name);
  }
};

/** One connection per database name. */
const database = function database(name: string): Promise<IDBDatabase> {
  const cached = dbCache.get(name);
  if (cached) {
    return cached;
  }
  const opening = openDatabase(name);
  dbCache.set(name, opening);
  void forgetFailedOpen(name, opening);
  return opening;
};

const readAll = async function readAll(
  name: string
): Promise<PersistedMutation[]> {
  const db = await database(name);
  const store = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE);
  // SAFETY: this object store only ever holds records this adapter wrote.
  const request = store.getAll() as IDBRequest<PersistedMutation[]>;
  // oxlint-disable-next-line promise/avoid-new -- IndexedDB request callbacks
  const entries = await new Promise<PersistedMutation[]>((resolve, reject) => {
    request.addEventListener("success", () => {
      resolve(request.result);
    });
    request.addEventListener("error", () => {
      reject(
        request.error ??
          new Error(`oxidejs: could not read IndexedDB "${name}"`)
      );
    });
  });
  return entries;
};

const runWrite = async function runWrite(
  name: string,
  run: (store: IDBObjectStore) => void
): Promise<void> {
  const db = await database(name);
  // oxlint-disable-next-line promise/avoid-new -- IndexedDB transaction callbacks
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, "readwrite");
    transaction.addEventListener("complete", () => {
      resolve();
    });
    transaction.addEventListener("error", () => {
      reject(
        transaction.error ??
          new Error(`oxidejs: IndexedDB "${name}" write failed`)
      );
    });
    transaction.addEventListener("abort", () => {
      reject(
        transaction.error ??
          new Error(`oxidejs: IndexedDB "${name}" write aborted`)
      );
    });
    run(transaction.objectStore(DB_STORE));
  });
};

/**
 * IndexedDB-backed {@link MutationQueueStorage} — browser only, no deps.
 * Throws when IndexedDB is missing (SSR, Node, locked-down webviews) so the
 * failure lands where the adapter is built. A store that is present but
 * unwritable (private mode) surfaces later as an `error` event.
 */
export const indexedDbStorage = function indexedDbStorage(
  name = DEFAULT_DB_NAME
): MutationQueueStorage {
  if (typeof indexedDB === "undefined") {
    throw new TypeError(
      "oxidejs: indexedDbStorage() needs the browser IndexedDB API, which is missing here (SSR/Node). Use createMutationQueue() without `storage`, or pass your own adapter."
    );
  }
  return {
    delete: async (id) => {
      await runWrite(name, (store) => {
        store.delete(id);
      });
    },
    load: () => readAll(name),
    put: async (entry) => {
      await runWrite(name, (store) => {
        store.put(entry);
      });
    },
  };
};

/**
 * Client-only write queue for `actions: "ws"`.
 * Enqueues on transient socket / network failures; drains FIFO on `flush`
 * with Effect Schedule backoff. Optimistic UI is app-owned — listen via
 * `subscribe`.
 *
 * Pass `storage` to keep failed writes across a reload. With storage, `wrap`
 * needs a stable `key` (and structured-cloneable args); persisted writes load
 * in FIFO order and replay once their action is wrapped. They have no awaiting
 * caller, so their outcomes arrive as `restore` / `success` / `discard`
 * events.
 */
export const createMutationQueue = function createMutationQueue(
  options?: CreateMutationQueueOptions
): MutationQueue {
  const retries = options?.retries ?? 4;
  const retryBase = options?.retryBase ?? "50 millis";
  const retryPolicy = transientRetry(retries, retryBase);
  const storage = options?.storage === "memory" ? undefined : options?.storage;

  const queue: QueuedMutation[] = [];
  const listeners = new Set<MutationQueueListener>();
  const inflightKeys = new Map<string, Promise<MutationOutcome>>();
  const runners = new Map<string, RunnerFactory>();
  let flushing: Promise<void> | null = null;
  // Wall-clock base keeps `seq` increasing across sessions, where a persisted
  // record from an earlier visit must sort before anything new.
  let nextSeq = Date.now();
  // Replaced by the storage load below; `flush` waits for it before draining.
  let ready: Promise<void> = Promise.resolve();
  // Set when a restored write has its action, so it drains without a caller.
  let restoredRunnable = false;

  const nextSequence = function nextSequence() {
    nextSeq = Math.max(nextSeq + 1, Date.now());
    return nextSeq;
  };

  const emit = function emit(
    type: "enqueue" | "flush" | "success" | "error" | "restore" | "discard",
    item?: MutationQueueItem,
    error?: Error
  ) {
    for (const listener of listeners) {
      if (item && error) {
        listener({ error, item, pending: queue.length, type });
      } else if (item) {
        listener({ item, pending: queue.length, type });
      } else if (error) {
        listener({ error, pending: queue.length, type });
      } else {
        listener({ pending: queue.length, type });
      }
    }
  };

  const runWithRetry = function runWithRetry(run: Runner) {
    return Effect.runPromise(
      Effect.tryPromise({
        catch: asError,
        try: run,
      }).pipe(Effect.retry(retryPolicy))
    );
  };

  /** Drop a persisted record; a storage failure is reported, never fatal. */
  const dropPersisted = async function dropPersisted(
    id: string,
    item?: MutationQueueItem
  ): Promise<void> {
    if (storage === undefined) {
      return;
    }
    try {
      await storage.delete(id);
    } catch (error) {
      emit("error", item, asError(error));
    }
  };

  /** Drop a queued item, in memory first, then from storage. */
  const dropItem = async function dropItem(
    item: QueuedMutation
  ): Promise<void> {
    const index = queue.indexOf(item);
    if (index !== -1) {
      queue.splice(index, 1);
    }
    inflightKeys.delete(item.id);
    await dropPersisted(item.id, toPublicItem(item));
  };

  /** Persist a queued item; a storage failure is reported, never fatal. */
  const persistItem = async function persistItem(
    target: MutationQueueStorage,
    item: QueuedMutation,
    entry: PersistedMutation
  ): Promise<void> {
    try {
      await target.put(entry);
    } catch (error) {
      emit("error", toPublicItem(item), asError(error));
    }
  };

  /** Run one queued item. Returns false when a transient failure ends the pass. */
  const drainItem = async function drainItem(
    item: RunnableMutation
  ): Promise<boolean> {
    try {
      // A durable record lands before its write attempt.
      await item.persisted;
      const value = await runWithRetry(item.run);
      await dropItem(item);
      item.resolve?.(value);
      emit("success", toPublicItem(item));
      return true;
    } catch (error) {
      const err = asError(error);
      if (isTransientFailure(err)) {
        emit("error", toPublicItem(item), err);
        return false;
      }
      await dropItem(item);
      item.reject?.(err);
      emit(item.restored ? "discard" : "error", toPublicItem(item), err);
      return true;
    }
  };

  const flush = function flush() {
    if (flushing) {
      return flushing;
    }
    flushing = (async () => {
      await ready;
      emit("flush");
      for (;;) {
        const item = queue.find(isRunnable);
        if (!item) {
          break;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- FIFO drain
        const next = await drainItem(item);
        if (!next) {
          return;
        }
      }
    })();
    const done = flushing;
    void (async () => {
      try {
        await done;
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  };

  /** Attach runners to restored items once their action is wrapped. */
  const attachKey = function attachKey(key: string) {
    const factory = runners.get(key);
    if (!factory) {
      return;
    }
    let attached = false;
    for (const item of queue) {
      if (item.run === undefined && item.key === key) {
        item.run = factory(item);
        attached = true;
      }
    }
    if (attached) {
      void flush();
    }
  };

  const restore = function restore(entries: PersistedMutation[]) {
    const restored: QueuedMutation[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (inflightKeys.has(entry.id) || seen.has(entry.id)) {
        // A live call already queued this write, or storage held a duplicate.
        void dropPersisted(entry.id);
        continue;
      }
      seen.add(entry.id);
      const item: QueuedMutation = {
        args: entry.args,
        createdAt: entry.createdAt,
        id: entry.id,
        key: entry.key,
        persisted: undefined,
        reject: undefined,
        resolve: undefined,
        restored: true,
        run: undefined,
        seq: entry.seq,
      };
      item.run = runners.get(entry.key)?.(item);
      restored.push(item);
      nextSeq = Math.max(nextSeq, entry.seq + 1);
    }
    if (restored.length === 0) {
      return;
    }
    // Restored writes are older than anything enqueued while the load ran.
    queue.unshift(...restored);
    for (const item of restored) {
      emit("restore", toPublicItem(item));
    }
    restoredRunnable = restored.some((item) => item.run !== undefined);
  };

  const load = (async () => {
    if (storage === undefined) {
      return;
    }
    let entries: PersistedMutation[];
    try {
      entries = await storage.load();
    } catch (error) {
      // Best effort: keep the queue usable in memory and report the failure.
      emit("error", undefined, asError(error));
      return;
    }
    const persisted: PersistedMutation[] = [];
    for (const entry of entries) {
      const decoded = decodePersistedMutation(entry);
      if (decoded !== undefined) {
        persisted.push(decoded);
      }
    }
    persisted.sort((a, b) => a.seq - b.seq);
    restore(persisted);
  })();
  ready = load;
  // A restored write with a registered action replays without waiting for a call.
  void (async () => {
    await load;
    if (restoredRunnable) {
      void flush();
    }
  })();

  if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
      void flush();
    });
  }

  return {
    flush,
    get pending() {
      return queue.length;
    },
    ready,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    wrap<Args extends unknown[], R>(
      fn: (...args: Args) => Promise<R>,
      wrapOptions?: WrapMutationOptions<Args>
    ) {
      // SAFETY: client handles brand themselves with the oxidejs ACTION_KEY.
      const key = wrapOptions?.key ?? readActionKey(fn as ActionKeyCarrier);

      /** One queued attempt: the handle erased to the FIFO argument shape. */
      const makeQueued = function makeQueued(
        id: string,
        args: MutationOutcome[]
      ): Runner {
        const erased: unknown = fn;
        // SAFETY: RPC stubs peel the trailing CallOptions bag; plain wrap targets ignore it.
        const call = erased as (
          ...callArgs: [...Args, { idempotencyKey: string }]
        ) => Promise<R>;
        // SAFETY: queue args hold the tuple the caller passed, erased for storage.
        const callArgs = args as Args;
        return async () => {
          const value = await call(...callArgs, { idempotencyKey: id });
          // SAFETY: R erased into the FIFO queue; wrap()/flush() restore it.
          return value as MutationOutcome;
        };
      };

      if (key !== undefined) {
        runners.set(key, (item) => makeQueued(item.id, item.args));
        attachKey(key);
      }
      return async (...args: Args) => {
        const id =
          wrapOptions?.idempotencyKey?.(...args) ?? crypto.randomUUID();
        const existing = inflightKeys.get(id);
        if (existing) {
          // SAFETY: same idempotency key reuses the in-flight Promise<R>.
          return existing as Promise<R>;
        }

        // SAFETY: Args erased into the FIFO queue; wrap() restores it for callers.
        const run = makeQueued(id, args as MutationOutcome[]);
        const pending = (async (): Promise<MutationOutcome> => {
          try {
            return await run();
          } catch (error) {
            const err = asError(error);
            if (!isTransientFailure(err)) {
              throw error;
            }
            const { promise, reject, resolve } = deferred<MutationOutcome>();
            const item: QueuedMutation = {
              // SAFETY: Args erased for public queue items; wrap() types the call.
              args: args as MutationOutcome[],
              createdAt: Date.now(),
              id,
              key,
              persisted: undefined,
              reject,
              resolve,
              restored: false,
              run,
              seq: nextSequence(),
            };
            let entry: PersistedMutation | undefined;
            if (storage !== undefined) {
              // Validates before the write queues: bad args throw to the caller.
              entry = persistEntry(item);
            }
            queue.push(item);
            emit("enqueue", toPublicItem(item));
            if (storage !== undefined && entry !== undefined) {
              item.persisted = persistItem(storage, item, entry);
            }
            return promise;
          } finally {
            if (!queue.some((queued) => queued.id === id)) {
              inflightKeys.delete(id);
            }
          }
        })();

        inflightKeys.set(id, pending);
        try {
          // SAFETY: wrap returns Promise<R>; successful path and flush resolve R.
          return (await pending) as R;
        } finally {
          if (!queue.some((queued) => queued.id === id)) {
            inflightKeys.delete(id);
          }
        }
      };
    },
  };
};
