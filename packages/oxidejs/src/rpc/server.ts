import { Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import type { Rpc, RpcGroup } from "effect/unstable/rpc";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { ACTION_PATH, matchesActionPath } from "../actions";
import type { ActionContext } from "../context";
import { runWithRequest, withRequestEntry } from "../context";
import { isSameOrigin } from "./same-origin";
import {
  ensureNdjsonBody,
  extractJsonRpcRequestIds,
  NDJSON_CONTENT,
  scrubNdjsonTransform,
  scrubRpcJson,
} from "./scrub";

export interface ActionHandlerOptions {
  createContext?: (req: Request) => ActionContext | Promise<ActionContext>;
  path?: string;
  sameOrigin?: boolean;
  transport?: "http" | "ws";
}

const JSON_RPC_FORBIDDEN = {
  error: { code: -32_600, message: "Forbidden" },
  id: null,
  jsonrpc: "2.0",
} as const;

interface HandlerBundle {
  dispose: () => Promise<void>;
  handler: (request: Request) => Promise<Response>;
}

type ActionGroup = RpcGroup.RpcGroup<Rpc.Any>;

const bundles = new Map<string, HandlerBundle>();
const groupIds = new WeakMap<ActionGroup, number>();
let nextGroupId = 0;

const serialization = RpcSerialization.layerNdJsonRpc();

const bundleKey = function bundleKey(
  group: ActionGroup,
  path: string,
  transport: "http" | "ws"
) {
  let id = groupIds.get(group);
  if (id === undefined) {
    id = nextGroupId;
    nextGroupId += 1;
    groupIds.set(group, id);
  }
  return `${id}:${path}:${transport}`;
};

const forbidden = function forbidden(): Response {
  return Response.json(JSON_RPC_FORBIDDEN, {
    headers: { "content-type": "application/json" },
    status: 403,
  });
};

const methodNotAllowed = function methodNotAllowed(): Response {
  return new Response("Method Not Allowed", {
    headers: { Allow: "POST" },
    status: 405,
  });
};

const buildBundle = function buildBundle(
  group: ActionGroup,
  handlers: Layer.Layer<unknown, unknown, unknown>,
  path: string,
  transport: "http" | "ws"
): HandlerBundle {
  const app = RpcServer.layerHttp({
    group,
    // SAFETY: Effect's path branded type accepts our runtime action path string.
    path: path as never,
    protocol: transport === "ws" ? "websocket" : "http",
  }).pipe(Layer.provide(handlers), Layer.provide(serialization));

  // SAFETY: toWebHandler's web adapter is structurally a HandlerBundle (handler + dispose).
  return HttpRouter.toWebHandler(app as never, {
    disableLogger: true,
  }) as HandlerBundle;
};

const bundleFor = function bundleFor(
  group: ActionGroup,
  handlers: Layer.Layer<unknown, unknown, unknown>,
  path: string,
  transport: "http" | "ws"
) {
  const key = bundleKey(group, path, transport);
  const cached = bundles.get(key);
  if (cached) {
    return cached;
  }
  const built = buildBundle(group, handlers, path, transport);
  bundles.set(key, built);
  return built;
};

const scrubJsonResponse = function scrubJsonResponse(
  response: Response,
  requestIds: ReturnType<typeof extractJsonRpcRequestIds>
): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    return response;
  }

  // Framed NDJSON stream — scrub line-by-line without buffering the generator.
  if (
    response.body &&
    (contentType.includes(NDJSON_CONTENT) || contentType.includes("ndjson"))
  ) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(
      response.body.pipeThrough(scrubNdjsonTransform(requestIds)),
      {
        headers,
        status: response.status,
        statusText: response.statusText,
      }
    );
  }

  // Non-stream fallback (e.g. plain application/json from our own Forbidden helper).
  return response;
};

const scrubBufferedJson = async function scrubBufferedJson(
  response: Response,
  requestIds: ReturnType<typeof extractJsonRpcRequestIds>
): Promise<Response> {
  const text = await response.text();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(scrubRpcJson(text, requestIds), {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

export const createActionHandler = function createActionHandler(
  group: ActionGroup,
  handlers: Layer.Layer<unknown, unknown, unknown>,
  options: ActionHandlerOptions = {}
) {
  const path = options.path ?? ACTION_PATH;
  const transport = options.transport ?? "http";
  const sameOrigin = options.sameOrigin ?? true;

  return async function handleActionRequest(
    request: Request
  ): Promise<Response> {
    if (!matchesActionPath(new URL(request.url).pathname, path)) {
      return new Response("Not Found", { status: 404 });
    }
    if (transport === "http" && request.method !== "POST") {
      return methodNotAllowed();
    }
    if (sameOrigin && !isSameOrigin(request)) {
      return forbidden();
    }

    return await withRequestEntry(async () => {
      const rawBody = ensureNdjsonBody(await request.arrayBuffer());
      const requestIds = extractJsonRpcRequestIds(rawBody);
      const headers = new Headers(request.headers);
      // Body is always NDJSON (trailing newline). Match the serialization layer.
      headers.set("content-type", NDJSON_CONTENT);

      const forwarded = new Request(request.url, {
        body: rawBody,
        headers,
        method: request.method,
        signal: request.signal,
      });

      const extra = (await options.createContext?.(forwarded)) ?? {};
      const { handler } = bundleFor(group, handlers, path, transport);
      const response = await runWithRequest(
        forwarded,
        () => handler(forwarded),
        extra
      );

      const contentType = response.headers.get("content-type") ?? "";
      if (
        contentType.includes(NDJSON_CONTENT) ||
        contentType.includes("ndjson")
      ) {
        return scrubJsonResponse(response, requestIds);
      }
      if (contentType.includes("json")) {
        return scrubBufferedJson(response, requestIds);
      }
      return response;
    });
  };
};

export const disposeActionHandler = function disposeActionHandler(
  group: ActionGroup,
  path: string = ACTION_PATH,
  transport: "http" | "ws" = "http"
) {
  const key = bundleKey(group, path, transport);
  const bundle = bundles.get(key);
  bundles.delete(key);
  return bundle?.dispose() ?? Promise.resolve();
};
