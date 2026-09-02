/** Strip Effect RPC `Defect` / `Cause` payloads down to plain JSON-RPC errors. */

const INTERNAL = { code: -32603, message: "Internal error" } as const;
const NDJSON_CONTENT = "application/json-rpc";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function classifyCause(error: Record<string, unknown>): { code: number; message: string } {
  const blob = `${String(error["message"] ?? "")}${JSON.stringify(error["data"] ?? "")}`;
  if (/Unknown request tag/i.test(blob)) {
    return { code: -32601, message: "Method not found" };
  }
  // Payload decode failures (not Effect's "Expected never" on typed Fail/Die exits).
  if (
    /Missing key/i.test(blob) ||
    (/Expected/i.test(blob) && /\["args"\]|\[\\"args\\"\]/.test(blob))
  ) {
    return { code: -32602, message: "Invalid params" };
  }
  // Interrupt / Empty / sequential|parallel Die trees → opaque internal error.
  return { ...INTERNAL };
}

function scrubError(error: unknown): { code: number; message: string } {
  if (!isRecord(error)) return { ...INTERNAL };

  if (error["_tag"] === "Defect") return { ...INTERNAL };
  if (error["_tag"] === "Cause") return classifyCause(error);

  // Plain JSON-RPC (Forbidden, parse errors, etc.) — keep code/message, drop data.
  if (typeof error["code"] === "number" && typeof error["message"] === "string") {
    return { code: error["code"], message: error["message"] };
  }
  return { ...INTERNAL };
}

/** Scrub one JSON-RPC response object. `requestIds` repairs Defect ids (= -32603). */
export function scrubRpcMessage(msg: unknown, requestIds: readonly unknown[] = []): unknown {
  if (!isRecord(msg) || !("error" in msg) || msg["error"] == null) return msg;

  const error = scrubError(msg["error"]);
  let id = msg["id"];
  if (id === -32603) {
    id = requestIds.length === 1 ? requestIds[0] : null;
  }
  if (id === undefined) id = null;

  return { jsonrpc: "2.0", id, error };
}

/**
 * Rewrite a JSON / NDJSON body so clients never see Effect `_tag` / `data` trees.
 * Accepts a single object, a JSON array, or newline-delimited frames.
 */
export function scrubRpcJson(body: string, requestIds: readonly unknown[] = []): string {
  const trimmed = body.replace(/^\uFEFF/, "");
  if (!trimmed) return body;

  // NDJSON: one or more newline-terminated frames (possibly without a final newline).
  if (trimmed.includes("\n")) {
    const lines = trimmed.split("\n");
    const out: string[] = [];
    for (const line of lines) {
      if (line === "") {
        // Preserve trailing newline as an empty trailing segment from split.
        continue;
      }
      out.push(scrubRpcLine(line, requestIds));
    }
    const endsWithNl = trimmed.endsWith("\n");
    return endsWithNl ? `${out.join("\n")}\n` : out.join("\n");
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return JSON.stringify(parsed.map((msg) => scrubRpcMessage(msg, requestIds)));
    }
    return JSON.stringify(scrubRpcMessage(parsed, requestIds));
  } catch {
    return body;
  }
}

function scrubRpcLine(line: string, requestIds: readonly unknown[]): string {
  try {
    return JSON.stringify(scrubRpcMessage(JSON.parse(line), requestIds));
  } catch {
    return line;
  }
}

/** Collect JSON-RPC request ids from a unary object or batch array body. */
export function extractJsonRpcRequestIds(body: ArrayBuffer | Uint8Array | string): unknown[] {
  try {
    let text =
      typeof body === "string"
        ? body
        : new TextDecoder().decode(body instanceof Uint8Array ? body : new Uint8Array(body));
    text = text.replace(/^\uFEFF/, "").trimEnd();
    // NDJSON request batch: one object per line.
    if (text.includes("\n")) {
      const ids: unknown[] = [];
      for (const line of text.split("\n")) {
        if (!line) continue;
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed) && "id" in parsed) ids.push(parsed["id"]);
      }
      return ids;
    }
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed
        .filter(isRecord)
        .filter((item) => "id" in item)
        .map((item) => item["id"]);
    }
    if (isRecord(parsed) && "id" in parsed) return [parsed["id"]];
  } catch {
    /* ignore */
  }
  return [];
}

/** @deprecated use extractJsonRpcRequestIds */
export function extractJsonRpcRequestId(body: ArrayBuffer | string): unknown {
  return extractJsonRpcRequestIds(body)[0];
}

/** Ensure a body is a valid NDJSON frame (Effect's ndJsonRpc decode requires a trailing newline). */
export function ensureNdjsonBody(buf: ArrayBuffer): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(buf);
  if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0a) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  out[bytes.length] = 0x0a;
  return out as Uint8Array<ArrayBuffer>;
}

/**
 * TransformStream that scrubs Effect defect payloads one NDJSON line at a time,
 * so long-running stream actions stay incremental.
 */
export function scrubNdjsonTransform(
  requestIds: readonly unknown[] = [],
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let nl = pending.indexOf("\n");
      while (nl !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line.length > 0) {
          controller.enqueue(encoder.encode(`${scrubRpcLine(line, requestIds)}\n`));
        }
        nl = pending.indexOf("\n");
      }
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending.length > 0) {
        controller.enqueue(encoder.encode(`${scrubRpcLine(pending, requestIds)}\n`));
        pending = "";
      }
    },
  });
}

export { NDJSON_CONTENT };
