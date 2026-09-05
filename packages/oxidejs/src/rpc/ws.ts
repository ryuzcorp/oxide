import type { Layer } from "effect";
import type { Rpc, RpcGroup } from "effect/unstable/rpc";

import { matchesActionPath } from "../actions";
import type { ActionContext, ActionContextValue } from "../context";
import type { OxidejsJson } from "../types";
import { isSameOrigin } from "./same-origin";
import { NDJSON_CONTENT } from "./scrub";
import type { ActionHandlerOptions } from "./server";
import { createActionHandler } from "./server";

interface WsPeerContext {
  [key: string]: ActionContextValue;
}

interface WsPeer {
  context: WsPeerContext;
  /** Optional: register a listener when the peer disconnects. */
  onClose?: (fn: () => void) => void;
  request?: Request;
  send: (data: string) => void;
}

interface WsMessage {
  text: () => string;
}

export interface WsHooksOptions {
  createContext?: (peer: WsPeer) => ActionContext | Promise<ActionContext>;
  maxMessageSize?: number;
  path?: string;
  sameOrigin?: boolean;
}

const parseMessage = function parseMessage(
  message: WsMessage,
  maxBytes: number
) {
  try {
    const raw = message.text();
    const size = new TextEncoder().encode(raw).byteLength;
    if (size > maxBytes) {
      return { ok: false as const, tooLarge: true };
    }
    return { ok: true as const, value: raw };
  } catch {
    return { ok: false as const };
  }
};

const isJsonRpcPing = function isJsonRpcPing(
  value: OxidejsJson
): value is { [key: string]: OxidejsJson } {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    value["method"] === "@effect/rpc/Ping"
  );
};

/**
 * Effect's socket client sends `@effect/rpc/Ping` keepalives (no id) and hangs
 * up unless the server answers `@effect/rpc/Pong`. Handle control messages here
 * so they never reach the action handler.
 */
const controlReply = function controlReply(raw: string): string | undefined {
  try {
    // SAFETY: JSON.parse yields JSON values; OxidejsJson is the repo's JSON union.
    const parsed = JSON.parse(raw) as OxidejsJson;
    if (isJsonRpcPing(parsed)) {
      return JSON.stringify({ jsonrpc: "2.0", method: "@effect/rpc/Pong" });
    }
  } catch {
    // Not JSON — let the action handler produce the parse error.
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- required by noImplicitReturns
  return undefined;
};

/** Forward each complete NDJSON line as its own WS message (keeps streams incremental). */
const sendNdjsonFrames = async function sendNdjsonFrames(
  peer: WsPeer,
  response: Response,
  signal: AbortSignal
) {
  if (signal.aborted) {
    await response.body?.cancel();
    return;
  }
  if (!response.body) {
    const text = await response.text();
    if (text && !signal.aborted) {
      peer.send(text);
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const onAbort = function onAbort() {
    void reader.cancel();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const pump = async function pump(): Promise<void> {
    for (;;) {
      if (signal.aborted) {
        return;
      }
      // Sequential stream pull — must await each chunk before the next.
      // oxlint-disable-next-line eslint/no-await-in-loop -- body must be drained in order
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      pending += decoder.decode(value, { stream: true });
      let nl = pending.indexOf("\n");
      while (nl !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line.length > 0 && !signal.aborted) {
          peer.send(`${line}\n`);
        }
        nl = pending.indexOf("\n");
      }
    }
  };

  try {
    await pump();

    if (!signal.aborted) {
      pending += decoder.decode();
      if (pending.length > 0) {
        peer.send(pending.endsWith("\n") ? pending : `${pending}\n`);
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

export const createWsHooks = function createWsHooks(
  group: RpcGroup.RpcGroup<Rpc.Any>,
  handlers: Layer.Layer<unknown, unknown, unknown>,
  options: WsHooksOptions = {}
) {
  const path = options.path ?? "/__oxide/action";
  const maxBytes = options.maxMessageSize ?? 1_048_576;
  const sameOrigin = options.sameOrigin ?? true;
  const baseOptions: ActionHandlerOptions = {
    path,
    sameOrigin,
    transport: "http",
  };

  return {
    async message(peer: WsPeer, message: WsMessage) {
      const parsed = parseMessage(message, maxBytes);
      if (!parsed.ok) {
        peer.send(
          JSON.stringify({
            error: {
              code: -32_600,
              message: parsed.tooLarge ? "Payload too large" : "Parse error",
            },
            id: null,
            jsonrpc: "2.0",
          })
        );
        return;
      }

      const pingReply = controlReply(parsed.value);
      if (pingReply !== undefined) {
        peer.send(pingReply);
        return;
      }

      const abort = new AbortController();
      peer.onClose?.(() => abort.abort());

      const host = peer.request?.headers.get("host") ?? "localhost";
      const headers = new Headers(peer.request?.headers);
      headers.set("content-type", NDJSON_CONTENT);

      // Resolve once per message. Handler clones the Request, so do not key context by Request identity.
      // SAFETY: peer.context is the host-supplied ActionContext bag; req is attached below.
      const peerCtx =
        (await options.createContext?.(peer)) ??
        (peer.context as ActionContext);
      const rpc = createActionHandler(group, handlers, {
        ...baseOptions,
        createContext: (req) => ({ ...peerCtx, req }),
      });

      const request = new Request(`http://${host}${path}`, {
        body: parsed.value,
        headers,
        method: "POST",
        signal: abort.signal,
      });

      const response = await rpc(request);
      await sendNdjsonFrames(peer, response, abort.signal);
    },
    upgrade(req: Request): Response | undefined {
      let pathname: string;
      try {
        ({ pathname } = new URL(req.url));
      } catch {
        return new Response("Bad Request", { status: 400 });
      }
      if (!matchesActionPath(pathname, path)) {
        return new Response("Not Found", { status: 404 });
      }
      if (sameOrigin && !isSameOrigin(req)) {
        return new Response("Forbidden", { status: 403 });
      }
      // oxlint-disable-next-line unicorn/no-useless-undefined -- required by noImplicitReturns
      return undefined;
    },
  };
};
