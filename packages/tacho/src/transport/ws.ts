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
  /** Max items in a JSON-RPC batch request. Default: 20. */
  maxBatchSize?: number;
  /** Max message size in bytes. Default: 1_048_576 (1 MB). */
  maxMessageSize?: number;
  /** Reject cross-origin upgrades (CSRF defense for cookie-authenticated RPC). Default: false. */
  sameOrigin?: boolean;
  /** Custom serializer for the JSON-RPC payload (e.g. superjson, msgpack). */
  serializer?: Serializer;
};

function parseMessage(
  message: Message,
  parse: (val: any) => any,
  maxBytes: number,
): { ok: true; value: unknown } | { ok: false; tooLarge?: true } {
  try {
    const raw = message.rawData === undefined ? message.text() : message.rawData;
    let size = 0;
    if (typeof raw === "string") size = new TextEncoder().encode(raw).byteLength;
    else if (raw instanceof Blob) size = raw.size;
    else if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) size = raw.byteLength;
    if (size > maxBytes) return { ok: false, tooLarge: true };
    return { ok: true, value: parse(raw as string) };
  } catch {
    return { ok: false };
  }
}

function isSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (request.headers.get("host") ?? new URL(request.url).host);
  } catch {
    return false;
  }
}

async function dispatch(
  router: AnyRouter,
  raw: unknown,
  ctx: Context,
  maxBatch: number,
): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
  if (Array.isArray(raw)) {
    if (raw.length > maxBatch) {
      return {
        jsonrpc: "2.0",
        error: { code: JSON_RPC_ERROR.INVALID_REQUEST, message: "Batch too large" },
        id: null,
      };
    }
    return runBatch(router, raw, ctx);
  }
  return runOne(router, raw, ctx);
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
      if (opts.sameOrigin && !isSameOrigin(req)) {
        return new Response("Forbidden", { status: 403 });
      }
      return undefined;
    },
    async message(peer: Peer, message: Message) {
      const parsed = parseMessage(message, parse, opts.maxMessageSize ?? 1_048_576);
      if (!parsed.ok) {
        peer.send(
          stringify({
            jsonrpc: "2.0",
            error: {
              code: parsed.tooLarge ? JSON_RPC_ERROR.INVALID_REQUEST : JSON_RPC_ERROR.PARSE_ERROR,
              message: parsed.tooLarge ? "Payload too large" : "Parse error",
            },
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
        const result = await dispatch(router, parsed.value, ctx, opts.maxBatchSize ?? 20);
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
