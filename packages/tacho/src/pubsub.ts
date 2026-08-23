/**
 * In-memory typed pub/sub for streaming procedures: one procedure publishes,
 * another's async generator subscribes and yields over SSE.
 *
 * Plain Map/Set — runs on Bun, Node, and Workers (workerd) alike. One
 * instance lives in exactly one isolate: inside a Durable Object, keep the
 * publisher and its stream procedures in the same cell.
 *
 * ponytail: synchronous, memory-only, no resume/replay. Cross-cell or
 * durable events need stub RPC / storage.
 */
export class Publisher<Events extends Record<string, unknown>> {
  #subs = new Map<string, Set<(payload: unknown) => void>>();

  publish<K extends keyof Events & string>(event: K, payload: Events[K]): void {
    const subs = this.#subs.get(event);
    if (!subs) return;
    for (const push of subs) push(payload);
  }

  /** Resolves with the next payload, or undefined if aborted/closed first. */
  once<K extends keyof Events & string>(event: K, options?: { signal?: AbortSignal }) {
    const sub = this.subscribe(event, options);
    return sub
      .next()
      .then(({ done, value }) => (done ? undefined : (value as Events[K])))
      .finally(() => sub.return());
  }

  subscribe<K extends keyof Events & string>(event: K, options?: { signal?: AbortSignal }) {
    const { signal } = options ?? {}; // ponytail: add options here when the 2nd param grows
    // ponytail: unbounded queue per subscriber; add backpressure if streams outrun publishers
    const queue: Events[K][] = [];
    let wake: (() => void) | undefined;
    let open = true;

    const push = (payload: unknown) => {
      if (!open) return;
      queue.push(payload as Events[K]);
      wake?.();
      wake = undefined;
    };

    const subs = this.#subs.get(event) ?? new Set<(payload: unknown) => void>();
    this.#subs.set(event, subs);

    const cleanup = () => {
      subs.delete(push);
      if (subs.size === 0) this.#subs.delete(event);
      signal?.removeEventListener("abort", stop);
    };
    const stop = () => {
      if (!open) return;
      open = false;
      cleanup();
      wake?.();
      wake = undefined;
    };

    subs.add(push);
    signal?.addEventListener("abort", stop);
    if (signal?.aborted) stop();

    const gen = (async function* () {
      try {
        while (open) {
          if (queue.length) {
            yield queue.shift() as Events[K];
          } else {
            await new Promise<void>((resolve) => (wake = resolve));
          }
        }
      } finally {
        cleanup();
      }
    })();

    // A generator suspended at the wake promise cannot settle, so a plain
    // .return() (including `break` in `for await`) would hang. Close first,
    // then delegate.
    const rawReturn = gen.return.bind(gen);
    return Object.assign(gen, {
      return: (value?: void) => {
        stop();
        return rawReturn(value);
      },
    });
  }
}
