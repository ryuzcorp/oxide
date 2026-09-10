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
  /**
   * Accept the server socket. Default: `server.accept()`.
   * Durable Object apps can pass `(ws) => ctx.acceptWebSocket(ws)` for hibernation.
   */
  accept?: (server: WebSocket, request: Request) => void;
  createContext?: (peer: WsPeer) => ActionContext | Promise<ActionContext>;
  maxMessageSize?: number;
  path?: string;
  sameOrigin?: boolean;
}

/** Hostname without port; brackets stripped for IPv6. */
const hostnameOf = function hostnameOf(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host.toLowerCase() : host.slice(1, end).toLowerCase();
  }
  const colon = host.lastIndexOf(":");
  // IPv6 without brackets has multiple colons — leave as-is.
  if (colon !== -1 && host.indexOf(":") === colon) {
    return host.slice(0, colon).toLowerCase();
  }
  return host.toLowerCase();
};

const isLoopbackHost = function isLoopbackHost(host: string): boolean {
  const name = hostnameOf(host);
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
};

/**
 * True when this request is a WebSocket upgrade. Prefer `Upgrade`, but also
 * accept `Sec-WebSocket-Key` — some hosts (celld) may strip `Upgrade` while
 * still expecting a 101 + `webSocket` Response.
 */
export const isWebsocketUpgradeRequest = function isWebsocketUpgradeRequest(
  request: Request
): boolean {
  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return true;
  }
  return request.headers.get("Sec-WebSocket-Key") !== null;
};

/**
 * sameOrigin for WebSocket upgrades. celld (and some proxies) omit Origin /
 * Sec-Fetch-Site on the upgrade request — allow that case when Host matches
 * the request URL (treating localhost / 127.0.0.1 / ::1 as equivalent). If
 * either header is present, use the normal CSRF check.
 */
export const isWsUpgradeSameOrigin = function isWsUpgradeSameOrigin(
  request: Request
): boolean {
  if (isSameOrigin(request)) {
    return true;
  }
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (origin || site) {
    return false;
  }
  try {
    const urlHost = new URL(request.url).host;
    const host = request.headers.get("host") ?? urlHost;
    if (host === urlHost) {
      return true;
    }
    return isLoopbackHost(host) && isLoopbackHost(urlHost);
  } catch {
    return false;
  }
};

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
 * up unless the server answers `@effect/rpc/Pong`. NDJSON framing requires a
 * trailing newline — without it the client never parses the Pong and times out.
 */
const controlReply = function controlReply(raw: string): string | undefined {
  try {
    // SAFETY: JSON.parse yields JSON values; OxidejsJson is the repo's JSON union.
    const parsed = JSON.parse(raw) as OxidejsJson;
    if (isJsonRpcPing(parsed)) {
      return `${JSON.stringify({ jsonrpc: "2.0", method: "@effect/rpc/Pong" })}\n`;
    }
  } catch {
    // Not JSON — let the action handler produce the parse error.
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- required by noImplicitReturns
  return undefined;
};

const messageText = function messageText(
  data: string | ArrayBuffer | ArrayBufferView
) {
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  return data;
};

interface WorkerSocket extends WebSocket {
  accept: () => void;
}

interface WorkerWebSocketPair {
  0: WorkerSocket;
  1: WorkerSocket;
}

const workerWebSocketPair = function workerWebSocketPair() {
  // SAFETY: Cloudflare Workers expose WebSocketPair; Node and Bun do not.
  const api = globalThis as typeof globalThis & {
    WebSocketPair?: new () => WorkerWebSocketPair;
  };
  return api.WebSocketPair ? new api.WebSocketPair() : undefined;
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

const WS_CONNECTING = 0;
const WS_OPEN = 1;

/** True when the socket can still accept `send` (Workers may omit `WebSocket.OPEN`). */
const canSendOnSocket = function canSendOnSocket(socket: {
  readyState?: number;
}): boolean {
  const state = socket.readyState;
  // After accept(), CF sockets are open; some runtimes leave readyState unset.
  if (state === undefined) {
    return true;
  }
  return state === WS_OPEN || state === WS_CONNECTING;
};

/**
 * URL for the synthetic HTTP action Request built from a WS upgrade.
 * Preserve https — auth cookies (e.g. Better Auth `__Secure-*`) are keyed off
 * the request origin scheme. Always forcing `http://` makes getSession miss
 * Secure cookies set on `https://*.workers.dev`.
 */
export const wsActionRequestUrl = function wsActionRequestUrl(
  upgrade: Request | undefined,
  actionPath: string
): string {
  if (upgrade) {
    try {
      const url = new URL(upgrade.url);
      url.protocol =
        url.protocol === "https:" || url.protocol === "wss:"
          ? "https:"
          : "http:";
      url.pathname = actionPath;
      url.search = "";
      url.hash = "";
      return url.href;
    } catch {
      // fall through to Host header
    }
  }
  const host = upgrade?.headers.get("host") ?? "localhost";
  return `http://${host}${actionPath}`;
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
    // Synthetic POST into createActionHandler — NDJSON over HTTP framing, not Effect's WS protocol.
    transport: "http",
  };

  const message = async function message(peer: WsPeer, msg: WsMessage) {
    const parsed = parseMessage(msg, maxBytes);
    if (!parsed.ok) {
      peer.send(
        `${JSON.stringify({
          error: {
            code: -32_600,
            message: parsed.tooLarge ? "Payload too large" : "Parse error",
          },
          id: null,
          jsonrpc: "2.0",
        })}\n`
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

    const headers = new Headers(peer.request?.headers);
    headers.set("content-type", NDJSON_CONTENT);

    // Resolve once per message. Handler clones the Request, so do not key context by Request identity.
    // SAFETY: peer.context is the host-supplied ActionContext bag; req is attached below.
    const peerCtx =
      (await options.createContext?.(peer)) ?? (peer.context as ActionContext);
    // Upgrade already passed sameOrigin; skip re-check on the synthetic POST.
    const rpc = createActionHandler(group, handlers, {
      ...baseOptions,
      createContext: (req) => ({ ...peerCtx, req }),
      sameOrigin: false,
    });

    const request = new Request(wsActionRequestUrl(peer.request, path), {
      body: parsed.value,
      headers,
      method: "POST",
      signal: abort.signal,
    });

    const response = await rpc(request);
    await sendNdjsonFrames(peer, response, abort.signal);
  };

  /** Path/origin gate for Node `crossws` — undefined means proceed with the upgrade. */
  const upgrade = function upgrade(req: Request): Response | undefined {
    let pathname: string;
    try {
      ({ pathname } = new URL(req.url));
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    if (!matchesActionPath(pathname, path)) {
      return new Response("Not Found", { status: 404 });
    }
    if (sameOrigin && !isWsUpgradeSameOrigin(req)) {
      return new Response("Forbidden", { status: 403 });
    }
    // oxlint-disable-next-line unicorn/no-useless-undefined -- required by noImplicitReturns
    return undefined;
  };

  /**
   * Workers / celld: accept an inbound WebSocket via `WebSocketPair`.
   * Returns a 101 response, an error response, or undefined when the request
   * is not a WebSocket upgrade for this action path.
   */
  const handleUpgrade = function handleUpgrade(
    req: Request,
    context: WsPeerContext = {}
  ): Response | undefined {
    if (!isWebsocketUpgradeRequest(req)) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- required by noImplicitReturns
      return undefined;
    }
    const denied = upgrade(req);
    if (denied) {
      return denied;
    }
    const pair = workerWebSocketPair();
    if (!pair) {
      return new Response("WebSocket not supported", { status: 500 });
    }
    // Prefer indexed access — celld's pair is array-like (`length` makes
    // Object.values return [client, server, length]).
    const { 0: client, 1: server } = pair;
    if (options.accept) {
      options.accept(server, req);
    } else {
      server.accept();
    }

    const peer: WsPeer = {
      context: { ...context },
      onClose: (fn) => {
        server.addEventListener("close", () => fn());
        server.addEventListener("error", () => fn());
      },
      request: req,
      send: (data) => {
        if (!canSendOnSocket(server)) {
          return;
        }
        try {
          server.send(data);
        } catch {
          // Socket closed between the readyState check and send.
        }
      },
    };

    server.addEventListener("message", (event) => {
      // SAFETY: Workers deliver string or binary frames; both decode to NDJSON text.
      const data = event.data as string | ArrayBuffer | ArrayBufferView;
      // Fire-and-forget: per-message failures must not tear down the peer.
      void (async () => {
        try {
          await message(peer, {
            text: () => messageText(data),
          });
        } catch {
          // Effect will retry / Ping; keep the socket alive.
        }
      })();
    });

    // SAFETY: Cloudflare Workers ResponseInit includes `webSocket`.
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit);
  };

  return { handleUpgrade, message, upgrade };
};
