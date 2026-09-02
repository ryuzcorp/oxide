import { Layer } from "effect";
import type { Rpc } from "effect/unstable/rpc";
import { RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { HttpRouter } from "effect/unstable/http";
import { ACTION_PATH, matchesActionPath } from "../actions";
import { runWithRequest } from "../context";
import type { ActionContext } from "../context";
import { isSameOrigin } from "./same-origin";
import {
  ensureNdjsonBody,
  extractJsonRpcRequestIds,
  NDJSON_CONTENT,
  scrubNdjsonTransform,
  scrubRpcJson,
} from "./scrub";

export type ActionHandlerOptions = {
  path?: string;
  sameOrigin?: boolean;
  transport?: "http" | "ws";
  createContext?: (req: Request) => ActionContext | Promise<ActionContext>;
};

const JSON_RPC_FORBIDDEN = {
  jsonrpc: "2.0",
  error: { code: -32600, message: "Forbidden" },
  id: null,
} as const;

type HandlerBundle = {
  handler: (request: Request, ...args: unknown[]) => Promise<Response>;
  dispose: () => Promise<void>;
};

type ActionGroup = RpcGroup.RpcGroup<Rpc.Any>;

const bundles = new Map<string, HandlerBundle>();
const groupIds = new WeakMap<ActionGroup, number>();
let nextGroupId = 0;

const serialization = RpcSerialization.layerNdJsonRpc();

function bundleKey(group: ActionGroup, path: string, transport: "http" | "ws") {
  let id = groupIds.get(group);
  if (id === undefined) {
    id = nextGroupId++;
    groupIds.set(group, id);
  }
  return `${id}:${path}:${transport}`;
}

function forbidden(): Response {
  return new Response(JSON.stringify(JSON_RPC_FORBIDDEN), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

function methodNotAllowed(): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" },
  });
}

function buildBundle(
  group: ActionGroup,
  handlers: Layer.Layer<unknown, unknown, unknown>,
  path: string,
  transport: "http" | "ws",
): HandlerBundle {
  const app = RpcServer.layerHttp({
    group,
    path: path as never,
    protocol: transport === "ws" ? "websocket" : "http",
  }).pipe(Layer.provide(handlers), Layer.provide(serialization));

  return HttpRouter.toWebHandler(app as never, { disableLogger: true }) as HandlerBundle;
}

function bundleFor(
  group: ActionGroup,
  handlers: Layer.Layer<unknown, unknown, unknown>,
  path: string,
  transport: "http" | "ws",
) {
  const key = bundleKey(group, path, transport);
  const cached = bundles.get(key);
  if (cached) return cached;
  const built = buildBundle(group, handlers, path, transport);
  bundles.set(key, built);
  return built;
}

function scrubJsonResponse(response: Response, requestIds: readonly unknown[]): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return response;

  // Framed NDJSON stream — scrub line-by-line without buffering the generator.
  if (response.body && (contentType.includes(NDJSON_CONTENT) || contentType.includes("ndjson"))) {
    return new Response(response.body.pipeThrough(scrubNdjsonTransform(requestIds)), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  // Non-stream fallback (e.g. plain application/json from our own Forbidden helper).
  return response;
}

async function scrubBufferedJson(
  response: Response,
  requestIds: readonly unknown[],
): Promise<Response> {
  const text = await response.text();
  return new Response(scrubRpcJson(text, requestIds), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createActionHandler(
  group: ActionGroup,
  handlers: Layer.Layer<unknown, unknown, unknown>,
  options: ActionHandlerOptions = {},
) {
  const path = options.path ?? ACTION_PATH;
  const transport = options.transport ?? "http";
  const sameOrigin = options.sameOrigin ?? false;

  return async (request: Request): Promise<Response> => {
    if (!matchesActionPath(new URL(request.url).pathname, path)) {
      return new Response("Not Found", { status: 404 });
    }
    if (transport === "http" && request.method !== "POST") {
      return methodNotAllowed();
    }
    if (sameOrigin && !isSameOrigin(request)) {
      return forbidden();
    }

    const rawBody = ensureNdjsonBody(await request.arrayBuffer());
    const requestIds = extractJsonRpcRequestIds(rawBody);
    const headers = new Headers(request.headers);
    // Body is always NDJSON (trailing newline). Match the serialization layer.
    headers.set("content-type", NDJSON_CONTENT);

    const forwarded = new Request(request.url, {
      method: request.method,
      headers,
      body: rawBody,
      signal: request.signal,
    });

    const extra = (await options.createContext?.(forwarded)) ?? {};
    const { handler } = bundleFor(group, handlers, path, transport);
    const response = await runWithRequest(forwarded, () => handler(forwarded), extra);

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes(NDJSON_CONTENT) || contentType.includes("ndjson")) {
      return scrubJsonResponse(response, requestIds);
    }
    if (contentType.includes("json")) {
      return scrubBufferedJson(response, requestIds);
    }
    return response;
  };
}

export function disposeActionHandler(
  group: ActionGroup,
  path: string = ACTION_PATH,
  transport: "http" | "ws" = "http",
) {
  const key = bundleKey(group, path, transport);
  const bundle = bundles.get(key);
  bundles.delete(key);
  return bundle?.dispose() ?? Promise.resolve();
}
