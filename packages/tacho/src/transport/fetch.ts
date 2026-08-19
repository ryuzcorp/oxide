import {
  JSON_RPC_ERROR,
  RpcError,
  isRpcStream,
  runBatch,
  runOne,
  type AnyRouter,
  type Context,
  type JsonRpcId,
  type Serializer,
} from "../index";
import { extractFiles, fileHeaders, fromForm, injectFiles, toForm } from "../file";

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
};

function sseFrame(data: unknown, stringify: (val: any) => any, event?: string) {
  let json: string;
  try {
    json = stringify(data);
  } catch {
    json = safeFrame(data);
  }
  return `${event ? `event: ${event}\n` : ""}data: ${json}\n\n`;
}

function safeFrame(data: unknown): string {
  const id = data && typeof data === "object" ? ((data as { id?: JsonRpcId }).id ?? null) : null;
  return JSON.stringify({
    jsonrpc: "2.0",
    error: { code: JSON_RPC_ERROR.INTERNAL_ERROR, message: "Internal error" },
    id,
  });
}

function streamResponse(
  gen: AsyncGenerator<unknown, unknown>,
  id: JsonRpcId,
  request: Request,
  stringify: (val: any) => any,
  onError?: (err: unknown, req: Request) => void,
) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const abort = () => {
          void gen.return(undefined);
        };
        request.signal.addEventListener("abort", abort, { once: true });
        try {
          while (!request.signal.aborted) {
            const { value, done } = await gen.next();
            if (request.signal.aborted) break;
            controller.enqueue(
              encoder.encode(
                sseFrame(
                  { jsonrpc: "2.0", result: value ?? null, id },
                  stringify,
                  done ? "done" : undefined,
                ),
              ),
            );
            if (done) break;
          }
        } catch (err) {
          onError?.(err, request);
          const error =
            err instanceof RpcError
              ? err.data === undefined
                ? { code: err.code, message: err.message }
                : { code: err.code, message: err.message, data: err.data }
              : {
                  code: JSON_RPC_ERROR.INTERNAL_ERROR,
                  message: "Internal error",
                };
          try {
            controller.enqueue(
              encoder.encode(sseFrame({ jsonrpc: "2.0", error, id }, stringify, "error")),
            );
          } catch {
            // closed
          }
        } finally {
          request.signal.removeEventListener("abort", abort);
          controller.close();
        }
      },
      cancel() {
        void gen.return(undefined);
      },
    }),
    { headers: SSE_HEADERS },
  );
}

export type HandleOptions<C extends Context> = {
  createContext?: (req: Request) => C | Promise<C>;
  path?: string;
  onError?: (err: unknown, req: Request) => void;
  /** Max request body size in bytes. Default: 1_048_576 (1 MB). */
  maxBodySize?: number;
  /** Max items in a JSON-RPC batch request. Default: 20. */
  maxBatchSize?: number;
  /** Custom serializer for the JSON-RPC payload (e.g. superjson, msgpack). */
  serializer?: Serializer;
};

export function handle<R extends AnyRouter, C extends Context = {}>(
  router: R,
  opts: HandleOptions<C> = {},
) {
  const parse = opts.serializer?.parse ?? JSON.parse;
  const stringify = opts.serializer?.stringify ?? JSON.stringify;
  const contentType = opts.serializer?.contentType ?? "application/json";

  const reply = (body: unknown, status = 200) => {
    const data = stringify(body);
    return new Response(data, {
      status,
      headers: { "content-type": contentType },
    });
  };

  return async (request: Request) => {
    if (opts.path && URL.parse(request.url)?.pathname !== opts.path) {
      return new Response("Not Found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    const maxBody = opts.maxBodySize ?? 1_048_576;
    const cl = Number(request.headers.get("content-length"));
    if (cl > maxBody) {
      return reply(
        {
          jsonrpc: "2.0",
          error: { code: JSON_RPC_ERROR.INVALID_REQUEST, message: "Payload too large" },
          id: null,
        },
        413,
      );
    }

    let body: unknown;
    try {
      const ct = request.headers.get("content-type") ?? "";
      if (ct.includes("multipart/form-data")) {
        const { rpc, files } = await fromForm(await request.formData(), parse);
        const envelope = rpc as { params?: unknown };
        envelope.params = injectFiles(envelope.params, files);
        body = envelope;
      } else if (
        ct.includes(contentType) ||
        (contentType === "application/json" && ct.includes("application/json"))
      ) {
        const isText = ct.includes("json") || ct.includes("text");
        const raw = isText ? await request.text() : new Uint8Array(await request.arrayBuffer());
        if ((typeof raw === "string" ? raw.length : raw.byteLength) > maxBody) {
          return reply(
            {
              jsonrpc: "2.0",
              error: { code: JSON_RPC_ERROR.INVALID_REQUEST, message: "Payload too large" },
              id: null,
            },
            413,
          );
        }
        body = parse(raw as string);
      } else {
        return reply(
          {
            jsonrpc: "2.0",
            error: {
              code: JSON_RPC_ERROR.INVALID_REQUEST,
              message: "Unsupported Content-Type",
            },
            id: null,
          },
          415,
        );
      }
    } catch {
      return reply({
        jsonrpc: "2.0",
        error: { code: JSON_RPC_ERROR.PARSE_ERROR, message: "Parse error" },
        id: null,
      });
    }

    try {
      const ctx = { req: request, ...((await opts.createContext?.(request)) ?? ({} as C)) };
      if (Array.isArray(body)) {
        const maxBatch = opts.maxBatchSize ?? 20;
        if (body.length > maxBatch) {
          return reply({
            jsonrpc: "2.0",
            error: {
              code: JSON_RPC_ERROR.INVALID_REQUEST,
              message: "Batch too large",
            },
            id: null,
          });
        }
        const result = await runBatch(router, body, ctx);
        return result ? reply(result) : new Response(null, { status: 204 });
      }
      const result = await runOne(router, body, ctx, { stream: true });
      if (isRpcStream(result)) {
        return streamResponse(
          result.gen,
          (body as { id?: JsonRpcId } | null)?.id ?? null,
          request,
          stringify,
          opts.onError,
        );
      }
      if (result && "result" in result) {
        const packed = extractFiles(result.result);
        const only = packed.files[0];
        if (packed.files.length === 1 && only && only.path.length === 0) {
          return new Response(only.file, { headers: fileHeaders(only.file) });
        }
        if (packed.files.length > 0) {
          return new Response(
            toForm(
              { jsonrpc: result.jsonrpc, result: packed.json, id: result.id },
              packed.files,
              stringify,
            ),
          );
        }
      }
      return result ? reply(result) : new Response(null, { status: 204 });
    } catch (err) {
      opts.onError?.(err, request);
      return reply(
        {
          jsonrpc: "2.0",
          error: {
            code: JSON_RPC_ERROR.INTERNAL_ERROR,
            message: "Internal error",
          },
          id: null,
        },
        500,
      );
    }
  };
}
