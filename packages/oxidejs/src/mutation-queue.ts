const TRANSIENT_CLOSE = /\b(?:1000|1001|1006)\b/u;

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

/** Erased wrap() return held until flush; typed back to R at the call site. */
type MutationOutcome =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | readonly MutationOutcome[]
  | { readonly [key: string]: MutationOutcome };

interface QueuedMutation {
  args: MutationOutcome[];
  createdAt: number;
  id: string;
  reject: (error: Error) => void;
  resolve: (value: MutationOutcome) => void;
  run: () => Promise<MutationOutcome>;
}

export interface MutationQueueItem {
  args: MutationOutcome[];
  createdAt: number;
  id: string;
}

export type MutationQueueListener = (event: {
  error?: Error;
  item?: MutationQueueItem;
  pending: number;
  type: "enqueue" | "flush" | "success" | "error";
}) => void;

export interface WrapMutationOptions<Args extends unknown[]> {
  /** Stable id per logical write. Default: new UUID per call. */
  idempotencyKey?: (...args: Args) => string;
}

export interface MutationQueue {
  readonly pending: number;
  flush: () => Promise<void>;
  subscribe: (listener: MutationQueueListener) => () => void;
  wrap: <Args extends unknown[], R>(
    fn: (...args: Args) => Promise<R>,
    options?: WrapMutationOptions<Args>
  ) => (...args: Args) => Promise<R>;
}

export interface CreateMutationQueueOptions {
  /** Reserved for IndexedDB persistence; only memory is implemented. */
  storage?: "memory";
}

const toPublicItem = function toPublicItem(
  item: QueuedMutation
): MutationQueueItem {
  return {
    args: item.args,
    createdAt: item.createdAt,
    id: item.id,
  };
};

/**
 * Client-only write queue for `actions: "ws"`.
 * Enqueues on transient socket / network failures; drains FIFO on `flush`.
 * Optimistic UI is app-owned — listen via `subscribe`.
 */
export const createMutationQueue = function createMutationQueue(
  _options?: CreateMutationQueueOptions
): MutationQueue {
  const queue: QueuedMutation[] = [];
  const listeners = new Set<MutationQueueListener>();
  const inflightKeys = new Map<string, Promise<MutationOutcome>>();
  let flushing: Promise<void> | null = null;

  const emit = function emit(
    type: "enqueue" | "flush" | "success" | "error",
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

  const flush = function flush() {
    if (flushing) {
      return flushing;
    }
    flushing = (async () => {
      emit("flush");
      while (queue.length > 0) {
        const [item] = queue;
        if (!item) {
          break;
        }
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- FIFO drain
          const value = await item.run();
          queue.shift();
          inflightKeys.delete(item.id);
          item.resolve(value);
          emit("success", toPublicItem(item));
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          if (isTransientFailure(err)) {
            emit("error", toPublicItem(item), err);
            return;
          }
          queue.shift();
          inflightKeys.delete(item.id);
          item.reject(err);
          emit("error", toPublicItem(item), err);
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
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    wrap<Args extends unknown[], R>(
      fn: (...args: Args) => Promise<R>,
      options?: WrapMutationOptions<Args>
    ) {
      return async (...args: Args) => {
        const id = options?.idempotencyKey?.(...args) ?? crypto.randomUUID();
        const existing = inflightKeys.get(id);
        if (existing) {
          // SAFETY: same idempotency key reuses the in-flight Promise<R>.
          return existing as Promise<R>;
        }

        const run = async (): Promise<MutationOutcome> => {
          const erased: unknown = fn;
          // SAFETY: stubs peel CallOptions; plain wrap targets ignore the trailing bag.
          const call = erased as (
            ...callArgs: [...Args, { idempotencyKey: string }]
          ) => Promise<R>;
          // SAFETY: R erased into the FIFO queue; wrap() restores it for callers.
          return (await call(...args, {
            idempotencyKey: id,
          })) as MutationOutcome;
        };
        const pending = (async (): Promise<MutationOutcome> => {
          try {
            return await run();
          } catch (error) {
            const err =
              error instanceof Error ? error : new Error(String(error));
            if (!isTransientFailure(err)) {
              throw error;
            }
            const { promise, reject, resolve } =
              Promise.withResolvers<MutationOutcome>();
            // SAFETY: Args erased for public queue items; wrap() still types the call.
            const item: QueuedMutation = {
              args: args as MutationOutcome[],
              createdAt: Date.now(),
              id,
              reject,
              resolve,
              run,
            };
            queue.push(item);
            emit("enqueue", toPublicItem(item));
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
