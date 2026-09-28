import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import type { Rpc, RpcGroup } from "effect/rpc";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { ACTION_PATH, matchesActionPath } from "../actions";
import type { ActionContext } from "../context";
import { runWithRequest, withRequestEntry } from "../context";
import type { OxidejsJson } from "../types";
import { isSameOrigin } from "./same-origin";
import {
  ensureNdjsonBody,
  extractJsonRpcRequestIds,
  NDJSON_CONTENT,
  scrubNdjsonTransform,
  scrubRpcJson,
} from "./scrub";
import type { JsonRpcId } from "./scrub";

export const IDEMPOTENCY_HEADER = "x-oxide-idempotency-key";

export interface ActionHandlerOptions {
  createContext?: (req: Request) => ActionContext | Promise<ActionContext>;
  path?: string;
  sameOrigin?: boolean;
  /**
   * Reject a request body larger than this many bytes with HTTP 413 before
   * any action runs. Default: no limit (the host's own limit applies).
   */
  maxBodyBytes?: number | undefined;
  /**
   * Answer with a JSON-RPC error when an action has not produced its response
   * within this many milliseconds, and interrupt it. Each call of a batch has
   * its own deadline. A stream counts as answered at its first frame.
   * Default: no limit.
   */
  timeoutMs?: number | undefined;
  transport?: "http" | "ws";
}

const JSON_RPC_FORBIDDEN = {
  error: { code: -32_600, message: "Forbidden" },
  id: null,
  jsonrpc: "2.0",
} as const;

const idempotencyFromHeaders = function idempotencyFromHeaders(
  headers: [string, string][] | { [key: string]: string }
) {
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (
        Array.isArray(entry) &&
        String(entry[0]).toLowerCase() === IDEMPOTENCY_HEADER
      ) {
        return String(entry[1]);
      }
    }
    // oxlint-disable-next-line unicorn/no-useless-undefined -- required by noImplicitReturns
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === IDEMPOTENCY_HEADER) {
      return value;
    }
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- required by noImplicitReturns
  return undefined;
};

interface IdempotencyFrame {
  headers?: [string, string][] | { [key: string]: string };
}

const extractIdempotencyKey = function extractIdempotencyKey(
  rawBody: Uint8Array,
  headers: Headers
) {
  const fromHeader = headers.get(IDEMPOTENCY_HEADER);
  if (fromHeader) {
    return fromHeader;
  }
  const text = new TextDecoder().decode(rawBody);
  const [line] = text.split("\n");
  if (!line) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- required by noImplicitReturns
    return undefined;
  }
  try {
    // SAFETY: JSON-RPC frames are JSON objects; a batch body is an array of them.
    const msg = JSON.parse(line) as IdempotencyFrame | IdempotencyFrame[];
    if (Array.isArray(msg)) {
      for (const frame of msg) {
        const key = frame.headers
          ? idempotencyFromHeaders(frame.headers)
          : undefined;
        if (key) {
          return key;
        }
      }
      // oxlint-disable-next-line unicorn/no-useless-undefined -- required by noImplicitReturns
      return undefined;
    }
    if (!msg.headers) {
      return;
    }
    return idempotencyFromHeaders(msg.headers);
  } catch {
    // Body is not JSON yet — Effect will surface the parse error.
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- required by noImplicitReturns
  return undefined;
};

interface HandlerBundle {
  dispose: () => Promise<void>;
  handler: (request: Request) => Promise<Response>;
}

type ActionGroup = RpcGroup.RpcGroup<Rpc.Any>;

const serialization = RpcSerialization.layerNdJsonRpc();

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

const payloadTooLarge = function payloadTooLarge(maxBytes: number): Response {
  return Response.json(
    {
      error: {
        code: -32_600,
        message: `Payload too large (limit ${maxBytes} bytes)`,
      },
      id: null,
      jsonrpc: "2.0",
    },
    { status: 413 }
  );
};

/**
 * One Effect RPC runtime per call. A runtime shared across requests is unsafe
 * on every host: its server fibers keep the request context of the request
 * that started them, so a concurrent action could read another request's
 * `useRequest()` / `useEnv()`. On Worker hosts (Cloudflare Workers, celld) it
 * also stalls, because the host drops a finished request's pending work.
 */
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

const scrubJsonResponse = function scrubJsonResponse(
  response: Response,
  requestIds: JsonRpcId[]
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
  requestIds: JsonRpcId[]
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

const INTERNAL_ERROR_CODE = -32_603;

/** One JSON-RPC error line per request id, in the NDJSON the client reads. */
const errorLines = function errorLines(
  requestIds: JsonRpcId[],
  message: string
): string {
  const ids = requestIds.length > 0 ? requestIds : [null];
  return ids
    .map(
      (id) =>
        `${JSON.stringify({
          error: { code: INTERNAL_ERROR_CODE, message },
          id,
          jsonrpc: "2.0",
        })}\n`
    )
    .join("");
};

const timeoutMessage = function timeoutMessage(timeoutMs: number): string {
  return `Action timed out after ${timeoutMs}ms`;
};

const TIMED_OUT = Symbol("oxidejs.actionTimeout");

/** Race `run` against `timeoutMs`; the timer is cleared either way. */
const withTimeout = async function withTimeout<T>(
  run: Promise<T>,
  timeoutMs: number | undefined
): Promise<T | typeof TIMED_OUT> {
  if (timeoutMs === undefined) {
    return await run;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  // oxlint-disable-next-line promise/avoid-new -- a timer-backed race needs its own Promise
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    return await Promise.race([run, expired]);
  } finally {
    clearTimeout(timer);
  }
};

/** Tear a runtime down; a failed teardown has nobody left to tell. */
const disposeQuietly = async function disposeQuietly(
  dispose: () => Promise<void>
): Promise<void> {
  try {
    await dispose();
  } catch {
    // The response is already decided; a failed teardown changes nothing.
  }
};

/** Dispose a per-call runtime once the response body is done (or dropped). */
const disposeAfterBody = function disposeAfterBody(
  response: Response,
  dispose: () => Promise<void>
): Response {
  const release = () => disposeQuietly(dispose);
  if (!response.body) {
    void release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    cancel: async (reason) => {
      try {
        await reader.cancel(reason);
      } finally {
        await release();
      }
    },
    pull: async (controller) => {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await release();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        await release();
      }
    },
  });
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
};

/** One JSON-RPC call of a request body: its NDJSON frame and its ids. */
interface ActionCall {
  body: Uint8Array<ArrayBuffer>;
  ids: JsonRpcId[];
}

const encoder = new TextEncoder();

/**
 * Split a body into its calls: a JSON array (batch) or several NDJSON lines
 * become one call each. Anything that does not parse stays one call, so
 * Effect answers it with its own parse error.
 */
const splitCalls = function splitCalls(
  rawBody: Uint8Array<ArrayBuffer>
): ActionCall[] {
  const whole = [{ body: rawBody, ids: extractJsonRpcRequestIds(rawBody) }];
  const text = new TextDecoder().decode(rawBody).replace(/^\uFEFF/u, "");
  const frames: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let parsed: OxidejsJson;
    try {
      // SAFETY: JSON.parse yields JSON values; OxidejsJson is the JSON value union.
      parsed = JSON.parse(line) as OxidejsJson;
    } catch {
      return whole;
    }
    if (!Array.isArray(parsed)) {
      frames.push(line);
      continue;
    }
    if (parsed.length === 0) {
      return whole;
    }
    for (const frame of parsed) {
      frames.push(JSON.stringify(frame));
    }
  }
  if (frames.length <= 1) {
    return whole;
  }
  return frames.map((frame) => ({
    body: encoder.encode(`${frame}\n`),
    ids: extractJsonRpcRequestIds(frame),
  }));
};

/** An AbortController that also aborts when `parent` does. */
const linkedAbort = function linkedAbort(parent: AbortSignal): AbortController {
  const abort = new AbortController();
  if (parent.aborted) {
    abort.abort(parent.reason);
  } else {
    parent.addEventListener("abort", () => abort.abort(parent.reason), {
      once: true,
    });
  }
  return abort;
};

/** Stream each call's NDJSON lines to the client as soon as that call ends. */
const mergeCallResponses = function mergeCallResponses(
  calls: ActionCall[],
  pending: Promise<Response>[]
): Response {
  // Set when the client cancels the body: later results have nowhere to go,
  // and enqueue on a cancelled stream throws.
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel: () => {
      cancelled = true;
    },
    start: async (controller) => {
      await Promise.all(
        pending.map(async (response, index) => {
          let text: string;
          try {
            const settled = await response;
            text = await settled.text();
          } catch {
            text = errorLines(calls[index]?.ids ?? [], "Internal error");
          }
          if (text === "" || cancelled) {
            return;
          }
          try {
            controller.enqueue(
              encoder.encode(text.endsWith("\n") ? text : `${text}\n`)
            );
          } catch {
            // The stream went away between the check and the enqueue.
            cancelled = true;
          }
        })
      );
      if (!cancelled) {
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: { "content-type": NDJSON_CONTENT },
    status: 200,
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
  const { maxBodyBytes, timeoutMs } = options;

  /** Run one call in its own runtime, bounded by `timeoutMs`. */
  const runCall = async function runCall(
    request: Request,
    call: ActionCall,
    extra: Partial<ActionContext>
  ): Promise<Response> {
    const headers = new Headers(request.headers);
    // Body is always NDJSON (trailing newline). Match the serialization layer.
    headers.set("content-type", NDJSON_CONTENT);
    headers.delete("content-length");
    // Aborts when the client goes away or the call times out.
    const abort = linkedAbort(request.signal);
    const forwarded = new Request(request.url, {
      body: call.body,
      headers,
      method: request.method,
      signal: abort.signal,
    });
    const idempotencyKey =
      extra.idempotencyKey ?? extractIdempotencyKey(call.body, request.headers);
    const callExtra: Partial<ActionContext> = { ...extra };
    if (idempotencyKey) {
      callExtra.idempotencyKey = idempotencyKey;
    }

    let bundle: HandlerBundle | undefined;
    let outcome: Response | typeof TIMED_OUT | undefined;
    try {
      // Build the runtime inside this call's request context: its server
      // fibers are forked during the build, and on celld they only see the
      // store they were created under (without `nodejs_compat`, a runtime
      // built outside it answers every action with "request context is
      // unavailable").
      outcome = await withTimeout(
        runWithRequest(
          forwarded,
          () => {
            const built = buildBundle(group, handlers, path, transport);
            bundle = built;
            return built.handler(forwarded);
          },
          callExtra
        ),
        timeoutMs
      );
    } finally {
      // A thrown handler leaves nothing to stream; release its runtime now.
      if (outcome === undefined) {
        await bundle?.dispose();
      }
    }

    if (outcome === TIMED_OUT) {
      abort.abort(new Error("oxidejs: action timed out"));
      // Do not await: the runtime we are tearing down is the one that hung.
      if (bundle) {
        void disposeQuietly(bundle.dispose);
      }
      return new Response(
        errorLines(call.ids, timeoutMessage(timeoutMs ?? 0)),
        {
          headers: { "content-type": NDJSON_CONTENT },
          status: 200,
        }
      );
    }

    const dispose = bundle?.dispose ?? (() => Promise.resolve());
    const contentType = outcome.headers.get("content-type") ?? "";
    if (
      contentType.includes(NDJSON_CONTENT) ||
      contentType.includes("ndjson")
    ) {
      return disposeAfterBody(scrubJsonResponse(outcome, call.ids), dispose);
    }
    if (contentType.includes("json")) {
      const buffered = await scrubBufferedJson(outcome, call.ids);
      await dispose();
      return buffered;
    }
    return disposeAfterBody(outcome, dispose);
  };

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
    if (maxBodyBytes !== undefined) {
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (declared > maxBodyBytes) {
        return payloadTooLarge(maxBodyBytes);
      }
    }

    return await withRequestEntry(async () => {
      const buffer = await request.arrayBuffer();
      if (maxBodyBytes !== undefined && buffer.byteLength > maxBodyBytes) {
        return payloadTooLarge(maxBodyBytes);
      }
      const rawBody = ensureNdjsonBody(buffer);
      // Host stamps env on the inbound Request; the per-call clones lack it.
      const hostExtra = (await options.createContext?.(request)) ?? {};
      const headerKey = request.headers.get(IDEMPOTENCY_HEADER);
      const extra: Partial<ActionContext> = { ...hostExtra };
      if (headerKey) {
        extra.idempotencyKey = headerKey;
      }

      const calls = splitCalls(rawBody);
      const [only] = calls;
      if (calls.length === 1 && only) {
        return await runCall(request, only, extra);
      }
      // A batch: every call gets its own runtime and deadline, and its result
      // goes out as soon as it is ready instead of waiting for the slowest.
      return mergeCallResponses(
        calls,
        calls.map((call) => runCall(request, call, extra))
      );
    });
  };
};

/**
 * @deprecated Action runtimes are built per request and disposed with their
 * response, so there is nothing cached to dispose. Kept for compatibility.
 */
export const disposeActionHandler = function disposeActionHandler(
  _group?: ActionGroup,
  _path: string = ACTION_PATH,
  _transport: "http" | "ws" = "http"
) {
  return Promise.resolve();
};
