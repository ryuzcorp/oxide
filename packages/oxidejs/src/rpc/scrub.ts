/** Strip Effect RPC `Defect` / `Cause` payloads down to plain JSON-RPC errors. */

import type { OxidejsJson } from "../types";

/** JSON-RPC request/response id. */
export type JsonRpcId = string | number | null;

interface JsonRpcErrorBody {
  code: number;
  message: string;
}

interface JsonObject {
  [key: string]: OxidejsJson;
}

const INTERNAL: JsonRpcErrorBody = { code: -32_603, message: "Internal error" };
const NDJSON_CONTENT = "application/json-rpc";

const isJsonObject = function isJsonObject(
  value: OxidejsJson
): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
};

const classifyCause = function classifyCause(
  error: JsonObject
): JsonRpcErrorBody {
  const blob = `${String(error["message"] ?? "")}${JSON.stringify(error["data"] ?? "")}`;
  if (/Unknown request tag/iu.test(blob)) {
    return { code: -32_601, message: "Method not found" };
  }
  // Payload decode failures (not Effect's "Expected never" on typed Fail/Die exits).
  if (
    /Missing key/iu.test(blob) ||
    (/Expected/iu.test(blob) && /\["args"\]|\[\\"args\\"\]/u.test(blob))
  ) {
    return { code: -32_602, message: "Invalid params" };
  }
  // Interrupt / Empty / sequential|parallel Die trees → opaque internal error.
  return { ...INTERNAL };
};

const isPlainJsonRpcError = function isPlainJsonRpcError(
  error: JsonObject
): error is JsonObject & { code: number; message: string } {
  return (
    typeof error["code"] === "number" && typeof error["message"] === "string"
  );
};

const scrubError = function scrubError(error: OxidejsJson): JsonRpcErrorBody {
  if (!isJsonObject(error)) {
    return { ...INTERNAL };
  }

  if (error["_tag"] === "Defect") {
    return { ...INTERNAL };
  }
  if (error["_tag"] === "Cause") {
    return classifyCause(error);
  }

  // Plain JSON-RPC (Forbidden, parse errors, etc.) — keep code/message, drop data.
  if (isPlainJsonRpcError(error)) {
    return { code: error["code"], message: error["message"] };
  }
  return { ...INTERNAL };
};

/** Mutable repair state so each Defect can claim a distinct originating request id. */
export interface IdRepairState {
  /** Request ids not yet claimed by a terminal (non-chunk) response. */
  remaining: Set<JsonRpcId>;
}

export const createIdRepairState = function createIdRepairState(
  requestIds: readonly JsonRpcId[] = []
): IdRepairState {
  return { remaining: new Set(requestIds) };
};

const parseOxidejsJson = function parseOxidejsJson(raw: string): OxidejsJson {
  // SAFETY: JSON.parse yields JSON values; OxidejsJson is the repo's JSON union.
  return JSON.parse(raw) as OxidejsJson;
};

/**
 * Scrub one JSON-RPC response object.
 * Effect encodes Defects with `id: -32603`; reclaim the originating request id from `state.remaining`.
 */
export const scrubRpcMessage = function scrubRpcMessage(
  msg: OxidejsJson,
  requestIds: readonly JsonRpcId[] = [],
  state: IdRepairState = createIdRepairState(requestIds)
): OxidejsJson {
  if (
    !isJsonObject(msg) ||
    !("error" in msg) ||
    msg["error"] === null ||
    msg["error"] === undefined
  ) {
    // Terminal success / chunk frames with a real id consume that id so later Defects don't steal it.
    if (
      isJsonObject(msg) &&
      msg["chunk"] !== true &&
      msg["id"] !== -32_603 &&
      "id" in msg
    ) {
      // SAFETY: JSON-RPC id values are string | number | null.
      state.remaining.delete(msg["id"] as JsonRpcId);
    }
    return msg;
  }

  const scrubbedError = scrubError(msg["error"]);
  let { id } = msg;
  if (id === -32_603) {
    const next = state.remaining.values().next();
    if (next.done) {
      id = null;
    } else {
      ({ value: id } = next);
      state.remaining.delete(next.value);
    }
  } else if (id !== undefined && id !== null) {
    // SAFETY: remaining ids were collected as JsonRpcId from request frames.
    state.remaining.delete(id as JsonRpcId);
  }
  if (id === undefined) {
    id = null;
  }

  // SAFETY: JSON-RPC error envelopes only carry JSON values (code/message/id).
  return {
    error: { code: scrubbedError.code, message: scrubbedError.message },
    id,
    jsonrpc: "2.0",
  } as OxidejsJson;
};

const scrubRpcLine = function scrubRpcLine(
  line: string,
  state: IdRepairState
): string {
  try {
    return JSON.stringify(scrubRpcMessage(parseOxidejsJson(line), [], state));
  } catch {
    return line;
  }
};

/**
 * Rewrite a JSON / NDJSON body so clients never see Effect `_tag` / `data` trees.
 * Accepts a single object, a JSON array, or newline-delimited frames.
 */
export const scrubRpcJson = function scrubRpcJson(
  body: string,
  requestIds: readonly JsonRpcId[] = []
): string {
  const trimmed = body.replace(/^\uFEFF/u, "");
  if (!trimmed) {
    return body;
  }
  const state = createIdRepairState(requestIds);

  // NDJSON: one or more newline-terminated frames (possibly without a final newline).
  if (trimmed.includes("\n")) {
    const lines = trimmed.split("\n");
    const out: string[] = [];
    for (const line of lines) {
      if (line === "") {
        // Preserve trailing newline as an empty trailing segment from split.
        continue;
      }
      out.push(scrubRpcLine(line, state));
    }
    const endsWithNl = trimmed.endsWith("\n");
    return endsWithNl ? `${out.join("\n")}\n` : out.join("\n");
  }

  try {
    const parsed = parseOxidejsJson(trimmed);
    if (Array.isArray(parsed)) {
      return JSON.stringify(
        parsed.map((msg) => scrubRpcMessage(msg, requestIds, state))
      );
    }
    return JSON.stringify(scrubRpcMessage(parsed, requestIds, state));
  } catch {
    return body;
  }
};

const requestBodyText = function requestBodyText(
  body: ArrayBuffer | Uint8Array | string
): string {
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(body));
  }
  return body;
};

const isJsonRpcId = function isJsonRpcId(
  value: OxidejsJson
): value is JsonRpcId {
  return (
    value === null || typeof value === "string" || typeof value === "number"
  );
};

/** Collect JSON-RPC request ids from a unary object or batch array body. */
export const extractJsonRpcRequestIds = function extractJsonRpcRequestIds(
  body: ArrayBuffer | Uint8Array | string
): JsonRpcId[] {
  try {
    let text = requestBodyText(body);
    text = text.replace(/^\uFEFF/u, "").trimEnd();
    // NDJSON request batch: one object per line.
    if (text.includes("\n")) {
      const ids: JsonRpcId[] = [];
      for (const line of text.split("\n")) {
        if (!line) {
          continue;
        }
        const parsed = parseOxidejsJson(line);
        if (
          isJsonObject(parsed) &&
          "id" in parsed &&
          isJsonRpcId(parsed["id"])
        ) {
          ids.push(parsed["id"]);
        }
      }
      return ids;
    }
    const parsed = parseOxidejsJson(text);
    if (Array.isArray(parsed)) {
      const ids: JsonRpcId[] = [];
      for (const item of parsed) {
        if (isJsonObject(item) && "id" in item && isJsonRpcId(item["id"])) {
          ids.push(item["id"]);
        }
      }
      return ids;
    }
    if (isJsonObject(parsed) && "id" in parsed && isJsonRpcId(parsed["id"])) {
      return [parsed["id"]];
    }
  } catch {
    /* ignore */
  }
  return [];
};

/** Ensure a body is a valid NDJSON frame (Effect's ndJsonRpc decode requires a trailing newline). */
export const ensureNdjsonBody = function ensureNdjsonBody(
  buf: ArrayBuffer
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(buf);
  if (bytes.length > 0 && bytes.at(-1) === 0x0a) {
    // SAFETY: Uint8Array view over ArrayBuffer is the same buffer brand Effect expects.
    return bytes as Uint8Array<ArrayBuffer>;
  }
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  out[bytes.length] = 0x0a;
  // SAFETY: newly allocated Uint8Array is backed by a plain ArrayBuffer.
  return out as Uint8Array<ArrayBuffer>;
};

/**
 * TransformStream that scrubs Effect defect payloads one NDJSON line at a time,
 * so long-running stream actions stay incremental.
 */
export const scrubNdjsonTransform = function scrubNdjsonTransform(
  requestIds: readonly JsonRpcId[] = []
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = createIdRepairState(requestIds);
  let pending = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    flush(controller) {
      pending += decoder.decode();
      if (pending.length > 0) {
        controller.enqueue(encoder.encode(`${scrubRpcLine(pending, state)}\n`));
        pending = "";
      }
    },
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let nl = pending.indexOf("\n");
      while (nl !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line.length > 0) {
          controller.enqueue(encoder.encode(`${scrubRpcLine(line, state)}\n`));
        }
        nl = pending.indexOf("\n");
      }
    },
  });
};

export { NDJSON_CONTENT };
