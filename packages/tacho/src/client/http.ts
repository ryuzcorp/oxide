import {
  createProxyClient,
  rpcResult,
  type CallOptions,
  type RPCClient,
  type Serializer,
} from "../index";
import { extractFiles, filenameFrom, fromForm, injectFiles, toForm } from "../file";
import { createQueryExtras, type QueryExtras } from "./query";

export type ClientOptions = {
  url: string;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Custom serializer for the JSON-RPC payload (e.g. superjson, msgpack). */
  serializer?: Serializer;
};

let nextId = 0;

function parseSse(
  block: string,
  parse: (val: any) => any,
): { event?: string; data: unknown } | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return;
  try {
    return event === undefined
      ? { data: parse(data.join("\n")) }
      : { event, data: parse(data.join("\n")) };
  } catch {
    return;
  }
}

async function* readSse(
  body: ReadableStream<Uint8Array>,
  ac: AbortController,
  cleanup: () => void,
  parse: (val: any) => any,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const event = parseSse(buf.slice(0, sep), parse);
        buf = buf.slice(sep + 2);
        if (!event) continue;
        if (event.event === "error") rpcResult(event.data as { error?: { message: string } });
        if (event.event === "done") return rpcResult(event.data as { result?: unknown });
        yield rpcResult(event.data as { result?: unknown });
      }
    }
  } finally {
    cleanup();
    ac.abort();
    await reader.cancel().catch(() => {});
  }
}

export function createClient<R>(opts: ClientOptions): RPCClient<R> & QueryExtras<R> {
  const parse = opts.serializer?.parse ?? JSON.parse;
  const stringify = opts.serializer?.stringify ?? JSON.stringify;
  const contentType = opts.serializer?.contentType ?? "application/json";

  const rawSend = async (method: string, params: unknown, call?: CallOptions) => {
    const headers = typeof opts.headers === "function" ? await opts.headers() : opts.headers;
    const ac = new AbortController();
    const signals = [opts.signal, call?.signal].filter((s): s is AbortSignal => !!s);
    const onAbort = () => ac.abort();
    for (const signal of signals) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener("abort", onAbort);
    }
    const cleanup = () => {
      for (const signal of signals) signal.removeEventListener("abort", onAbort);
    };
    try {
      const id = ++nextId;
      const packed = extractFiles(params);
      const envelope = { jsonrpc: "2.0", method, params: packed.json, id };
      const serialized = stringify(envelope);
      const init: RequestInit = {
        method: "POST",
        signal: ac.signal,
        ...(packed.files.length
          ? { body: toForm(envelope, packed.files, stringify) }
          : {
              headers: { "content-type": contentType, ...(headers as object) },
              body: serialized,
            }),
      };
      if (packed.files.length && headers) init.headers = headers;
      const response = await (opts.fetch ?? fetch)(opts.url, init);
      const ct = response.headers.get("content-type") ?? "";
      if (ct.includes("text/event-stream")) {
        if (!response.body) {
          cleanup();
          throw new Error(`RPC transport error: ${response.status} ${response.statusText}`);
        }
        return readSse(response.body, ac, cleanup, parse);
      }
      cleanup();
      if (response.headers.get("x-rpc-result") === "file") {
        const blob = await response.blob();
        return new File([blob], filenameFrom(response.headers.get("content-disposition")), {
          type: blob.type,
        });
      }
      if (ct.includes("multipart/form-data")) {
        const { rpc, files } = await fromForm(await response.formData(), parse);
        const envelope = rpc as { result?: unknown; error?: { message: string } };
        envelope.result = injectFiles(envelope.result, files);
        return rpcResult(envelope);
      }
      const isText = ct.includes("json") || ct.includes("text");
      const raw = isText ? await response.text() : new Uint8Array(await response.arrayBuffer());
      let body: unknown;
      try {
        body = await parse(raw as string);
      } catch {
        body = undefined;
      }
      if (!body) throw new Error(`RPC transport error: ${response.status} ${response.statusText}`);
      return rpcResult(body);
    } catch (err) {
      cleanup();
      throw err;
    }
  };
  return createProxyClient<R, QueryExtras<R>>(rawSend, createQueryExtras(rawSend));
}
