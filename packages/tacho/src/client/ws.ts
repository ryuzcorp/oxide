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
};

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

  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("RPC transport error")), {
      once: true,
    });
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
      try {
        waiter.resolve(rpcResult(item));
      } catch (err) {
        waiter.reject(err);
      }
    }
  });

  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error("RPC transport error: socket closed"));
    }
    pending.clear();
  });

  return createProxyClient<
    R,
    { ready: Promise<void>; close: (code?: number, reason?: string) => void }
  >(
    async (method, params) => {
      await ready;
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(stringify({ jsonrpc: "2.0", method, params, id }));
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
