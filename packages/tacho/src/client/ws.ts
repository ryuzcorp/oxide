import { createProxyClient, rpcResult, type RPCClient, type Serializer } from "../index";

export type WsClientOptions = {
  url: string;
  protocols?: string | string[];
  WebSocket?: typeof WebSocket;
  /** Custom serializer for the JSON-RPC payload (e.g. superjson, msgpack). */
  serializer?: Serializer;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  cleanup: (() => void) | undefined;
};

const abortReason = (signal: AbortSignal) =>
  signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

export function createClient<R>(opts: WsClientOptions): RPCClient<R> & {
  close: (code?: number, reason?: string) => void;
  ready: Promise<void>;
} {
  const parse = opts.serializer?.parse ?? JSON.parse;
  const stringify = opts.serializer?.stringify ?? JSON.stringify;

  const WS = opts.WebSocket ?? WebSocket;
  const socket = new WS(opts.url, opts.protocols);
  if ("binaryType" in socket) {
    socket.binaryType = "arraybuffer";
  }
  const pending = new Map<number | string, Pending>();
  let nextId = 0;

  let opened = false;
  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener(
      "open",
      () => {
        opened = true;
        resolve();
      },
      { once: true },
    );
    socket.addEventListener("error", () => reject(new Error("RPC transport error")), {
      once: true,
    });
    socket.addEventListener(
      "close",
      () => {
        if (!opened) reject(new Error("RPC transport error: socket closed"));
      },
      { once: true },
    );
  });

  socket.addEventListener("message", async (event) => {
    let body: unknown;
    try {
      const data = event.data;
      const raw =
        typeof Blob !== "undefined" && data instanceof Blob ? await data.arrayBuffer() : data;
      body = parse(raw as string);
    } catch {
      return;
    }
    for (const item of Array.isArray(body) ? body : [body]) {
      const id = (item as { id?: number | string | null })?.id;
      if (id === undefined || id === null) continue;
      const waiter = pending.get(id);
      if (!waiter) continue;
      pending.delete(id);
      waiter.cleanup?.();
      try {
        waiter.resolve(rpcResult(item));
      } catch (err) {
        waiter.reject(err);
      }
    }
  });

  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) {
      waiter.cleanup?.();
      waiter.reject(new Error("RPC transport error: socket closed"));
    }
    pending.clear();
  });

  return createProxyClient<
    R,
    { ready: Promise<void>; close: (code?: number, reason?: string) => void }
  >(
    async (method, params, call) => {
      const signal = call?.signal;
      let stopWaiting: (() => void) | undefined;
      if (signal) {
        await Promise.race([
          ready,
          new Promise<never>((_, reject) => {
            const abort = () => reject(abortReason(signal));
            stopWaiting = () => signal.removeEventListener("abort", abort);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          }),
        ]).finally(() => stopWaiting?.());
      } else {
        await ready;
      }

      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const abort = () => {
          pending.delete(id);
          reject(abortReason(signal!));
        };
        const cleanup = signal ? () => signal.removeEventListener("abort", abort) : undefined;
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
        pending.set(id, { resolve, reject, cleanup });
        try {
          socket.send(stringify({ jsonrpc: "2.0", method, params, id }));
        } catch (err) {
          pending.delete(id);
          cleanup?.();
          reject(err);
        }
      });
    },
    {
      ready,
      close(code?: number, reason?: string) {
        socket.close(code, reason);
      },
    },
  );
}
