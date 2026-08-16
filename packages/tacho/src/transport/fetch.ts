import {
  JSON_RPC_ERROR,
  RpcError,
  isRpcStream,
  runBatch,
  runOne,
  type AnyRouter,
  type Context,
  type JsonRpcId,
} from "../index";
import { extractFiles, fileHeaders, fromForm, injectFiles, toForm } from "../file";

const JSON_HEADERS = { "content-type": "application/json" };
const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function sseFrame(data: unknown, event?: string) {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

function streamResponse(
  gen: AsyncGenerator<unknown, unknown>,
  id: JsonRpcId,
  request: Request,
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
                sseFrame({ jsonrpc: "2.0", result: value ?? null, id }, done ? "done" : undefined),
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
                  message: err instanceof Error ? err.message : "Internal error",
                };
          try {
            controller.enqueue(encoder.encode(sseFrame({ jsonrpc: "2.0", error, id }, "error")));
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
};

export function handle<R extends AnyRouter, C extends Context = {}>(
  router: R,
  opts: HandleOptions<C> = {},
) {
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

    let body: unknown;
    try {
      const ct = request.headers.get("content-type") ?? "";
      if (ct.includes("multipart/form-data")) {
        const { rpc, files } = await fromForm(await request.formData());
        const envelope = rpc as { params?: unknown };
        envelope.params = injectFiles(envelope.params, files);
        body = envelope;
      } else {
        body = await request.json();
      }
    } catch {
      return json({
        jsonrpc: "2.0",
        error: { code: JSON_RPC_ERROR.PARSE_ERROR, message: "Parse error" },
        id: null,
      });
    }

    try {
      const ctx = { req: request, ...((await opts.createContext?.(request)) ?? ({} as C)) };
      if (Array.isArray(body)) {
        const result = await runBatch(router, body, ctx);
        return result ? json(result) : new Response(null, { status: 204 });
      }
      const result = await runOne(router, body, ctx, { stream: true });
      if (isRpcStream(result)) {
        return streamResponse(
          result.gen,
          (body as { id?: JsonRpcId } | null)?.id ?? null,
          request,
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
            toForm({ jsonrpc: result.jsonrpc, result: packed.json, id: result.id }, packed.files),
          );
        }
      }
      return result ? json(result) : new Response(null, { status: 204 });
    } catch (err) {
      opts.onError?.(err, request);
      return json(
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
