import {
  JSON_RPC_ERROR,
  runBatch,
  runOne,
  type AnyRouter,
  type Context,
  type JsonRpcResponse,
  type Serializer,
} from "../index";

type Peer = {
  request?: Request;
  context: Record<string, unknown>;
  send: (data: unknown) => unknown;
};

type Message = {
  text: () => string;
  json?: () => unknown;
  rawData?: unknown;
};

export type WsHandleOptions<C extends Context> = {
  createContext?: (peer: Peer) => C | Promise<C>;
  path?: string;
  onError?: (err: unknown, peer: Peer) => void;
  /** Custom serializer for the JSON-RPC payload (e.g. superjson, msgpack). */
  serializer?: Serializer;
};

function parseMessage(
  message: Message,
  parse: (val: any) => any,
): { ok: true; value: unknown } | { ok: false } {
  try {
    const raw = message.rawData === undefined ? message.text() : message.rawData;
    return {
      ok: true,
      value: parse(raw as string),
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
  const parse = opts.serializer?.parse ?? JSON.parse;
  const stringify = opts.serializer?.stringify ?? JSON.stringify;

  return {
    upgrade(req: Request) {
      if (opts.path && URL.parse(req.url)?.pathname !== opts.path) {
        return new Response("Not Found", { status: 404 });
      }
      return undefined;
    },
    async message(peer: Peer, message: Message) {
      const parsed = parseMessage(message, parse);
      if (!parsed.ok) {
        peer.send(
          stringify({
            jsonrpc: "2.0",
            error: { code: JSON_RPC_ERROR.PARSE_ERROR, message: "Parse error" },
            id: null,
          }),
        );
        return;
      }
      try {
        const ctx = {
          req: peer.request,
          ...((await opts.createContext?.(peer)) ?? ((peer.context ?? {}) as C)),
        };
        const result = await dispatch(router, parsed.value, ctx);
        if (result !== undefined) peer.send(stringify(result));
      } catch (err) {
        opts.onError?.(err, peer);
        peer.send(
          stringify({
            jsonrpc: "2.0",
            error: {
              code: JSON_RPC_ERROR.INTERNAL_ERROR,
              message: "Internal error",
            },
            id: null,
          }),
        );
      }
    },
  };
}
