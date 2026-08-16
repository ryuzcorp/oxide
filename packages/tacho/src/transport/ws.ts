import {
  JSON_RPC_ERROR,
  runBatch,
  runOne,
  type AnyRouter,
  type Context,
  type JsonRpcResponse,
} from "../index";

type Peer = {
  request?: Request;
  context: Record<string, unknown>;
  send: (data: unknown) => unknown;
};

type Message = {
  text: () => string;
  json?: () => unknown;
};

export type WsHandleOptions<C extends Context> = {
  createContext?: (peer: Peer) => C | Promise<C>;
  path?: string;
  onError?: (err: unknown, peer: Peer) => void;
};

function parseMessage(message: Message): { ok: true; value: unknown } | { ok: false } {
  try {
    return {
      ok: true,
      value: message.json ? message.json() : JSON.parse(message.text()),
    };
  } catch {
    return { ok: false };
  }
}

async function dispatch(
  router: AnyRouter,
  raw: unknown,
  ctx: Context,
): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
  return Array.isArray(raw) ? runBatch(router, raw, ctx) : runOne(router, raw, ctx);
}

export function handle<R extends AnyRouter, C extends Context = {}>(
  router: R,
  opts: WsHandleOptions<C> = {},
) {
  return {
    upgrade(req: Request) {
      if (opts.path && URL.parse(req.url)?.pathname !== opts.path) {
        return new Response("Not Found", { status: 404 });
      }
      return undefined;
    },
    async message(peer: Peer, message: Message) {
      const parsed = parseMessage(message);
      if (!parsed.ok) {
        peer.send({
          jsonrpc: "2.0",
          error: { code: JSON_RPC_ERROR.PARSE_ERROR, message: "Parse error" },
          id: null,
        });
        return;
      }
      try {
        const ctx = {
          req: peer.request,
          ...((await opts.createContext?.(peer)) ?? ((peer.context ?? {}) as C)),
        };
        const result = await dispatch(router, parsed.value, ctx);
        if (result !== undefined) peer.send(result);
      } catch (err) {
        opts.onError?.(err, peer);
        peer.send({
          jsonrpc: "2.0",
          error: {
            code: JSON_RPC_ERROR.INTERNAL_ERROR,
            message: "Internal error",
          },
          id: null,
        });
      }
    },
  };
}
