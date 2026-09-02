import type { Layer } from "effect";
import type { Rpc } from "effect/unstable/rpc";
import type { RpcGroup } from "effect/unstable/rpc";
import { runWithRequest } from "../context";
import type { ActionContext } from "../context";
import { isSameOrigin } from "./same-origin";
import { matchesActionPath } from "../actions";
import { createActionHandler, type ActionHandlerOptions } from "./server";
import { NDJSON_CONTENT } from "./scrub";

type WsPeer = {
  request?: Request;
  context: Record<string, unknown>;
  send: (data: unknown) => unknown;
};

type WsMessage = {
  text: () => string;
};

export type WsHooksOptions = {
  path?: string;
  sameOrigin?: boolean;
  maxMessageSize?: number;
  createContext?: (peer: WsPeer) => ActionContext | Promise<ActionContext>;
};

function parseMessage(message: WsMessage, maxBytes: number) {
  try {
    const raw = message.text();
    const size = new TextEncoder().encode(raw).byteLength;
    if (size > maxBytes) return { ok: false as const, tooLarge: true };
    return { ok: true as const, value: raw };
  } catch {
    return { ok: false as const };
  }
}

/** Forward each complete NDJSON line as its own WS message (keeps streams incremental). */
async function sendNdjsonFrames(peer: WsPeer, response: Response) {
  if (!response.body) {
    const text = await response.text();
    if (text) peer.send(text);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let nl = pending.indexOf("\n");
    while (nl !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line.length > 0) peer.send(`${line}\n`);
      nl = pending.indexOf("\n");
    }
  }

  pending += decoder.decode();
  if (pending.length > 0) peer.send(pending.endsWith("\n") ? pending : `${pending}\n`);
}

export function createWsHooks(
  group: RpcGroup.RpcGroup<Rpc.Any>,
  handlers: Layer.Layer<unknown, unknown, unknown>,
  options: WsHooksOptions = {},
) {
  const path = options.path ?? "/__oxide/action";
  const maxBytes = options.maxMessageSize ?? 1_048_576;
  const rpcOptions: ActionHandlerOptions = { path, transport: "http" };
  if (options.sameOrigin) rpcOptions.sameOrigin = true;
  rpcOptions.createContext = (req) => {
    const peer = (req as Request & { __oxidePeer?: WsPeer }).__oxidePeer;
    return {
      req,
      ...(peer ? ((options.createContext?.(peer) ?? peer.context) as ActionContext) : {}),
    };
  };
  const rpc = createActionHandler(group, handlers, rpcOptions);

  return {
    upgrade(req: Request) {
      if (!matchesActionPath(new URL(req.url).pathname, path)) {
        return new Response("Not Found", { status: 404 });
      }
      if (options.sameOrigin && !isSameOrigin(req)) {
        return new Response("Forbidden", { status: 403 });
      }
      return undefined;
    },
    async message(peer: WsPeer, message: WsMessage) {
      const parsed = parseMessage(message, maxBytes);
      if (!parsed.ok) {
        peer.send(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message: parsed.tooLarge ? "Payload too large" : "Parse error",
            },
            id: null,
          }),
        );
        return;
      }
      const host = peer.request?.headers.get("host") ?? "localhost";
      const headers = new Headers(peer.request?.headers);
      headers.set("content-type", NDJSON_CONTENT);
      const request = new Request(`http://${host}${path}`, {
        method: "POST",
        headers,
        body: parsed.value,
      });
      (request as Request & { __oxidePeer?: WsPeer }).__oxidePeer = peer;
      const extra = (await options.createContext?.(peer)) ?? (peer.context as ActionContext);
      const response = await runWithRequest(request, () => rpc(request), extra);
      await sendNdjsonFrames(peer, response);
    },
  };
}
