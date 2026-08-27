export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown> | unknown[];
  id?: JsonRpcId;
};

export type JsonRpcErrorObject = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcSuccessResponse = {
  jsonrpc: "2.0";
  result: unknown;
  id: JsonRpcId;
};

export type JsonRpcErrorResponse = {
  jsonrpc: "2.0";
  error: JsonRpcErrorObject;
  id: JsonRpcId;
};

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export const JSON_RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export const APP_ERROR_RANGE = { min: -32099, max: -32000 } as const;

export { Publisher } from "./pubsub";

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor({ code, message, data }: { code: number; message: string; data?: unknown }) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export type Serializer = {
  stringify: (val: unknown) => any;
  parse: (val: any) => unknown;
  contentType?: string;
};

export type Context = Record<string, unknown>;

export type Middleware<C extends Context> = (opts: {
  ctx: C;
  next: (opts?: { ctx: Partial<C> }) => Promise<unknown>;
}) => Promise<unknown>;

export type Schema<Out = unknown> = {
  "~standard": {
    validate: (
      value: unknown,
    ) => { value?: Out; issues?: unknown } | Promise<{ value?: Out; issues?: unknown }>;
  };
};

export type ProcedureDef<C extends Context, In, Out> = {
  (input?: In, ctx?: C): Promise<Out>;
  __rpc: true;
  inputSchema?: Schema<In> | undefined;
  outputSchema?: Schema<Out> | undefined;
  middlewares: Middleware<C>[];
  run: (opts: { input: In; ctx: C; signal: AbortSignal }) => Out | Promise<Out>;
};

export type AnyRouter = {
  [key: string]: ProcedureDef<any, any, any> | AnyRouter;
};

export const router = <T extends AnyRouter>(def: T): T => def;

declare const unset: unique symbol;
type Unset = typeof unset;

type HandlerResult<Out> =
  | Out
  | Promise<Out>
  | AsyncGenerator<Out, unknown, unknown>
  | Promise<AsyncGenerator<Out, unknown, unknown>>;

type Builder<C extends Context, In = undefined, Out = Unset> = {
  <T extends AnyRouter>(def: T): T;
  use(mw: Middleware<C>): Builder<C, In, Out>;
  input<Next>(schema: Schema<Next>): Builder<C, Next, Out>;
  output<Next>(schema: Schema<Next>): Builder<C, In, Next>;
  run: [Out] extends [Unset]
    ? <R>(
        fn: (opts: { input: In; ctx: C; signal: AbortSignal }) => R | Promise<R>,
      ) => ProcedureDef<C, In, R>
    : (
        fn: (opts: { input: In; ctx: C; signal: AbortSignal }) => HandlerResult<Out>,
      ) => ProcedureDef<C, In, Out>;
};

async function parseWith(
  schema: Schema | undefined,
  value: unknown,
  error: { code: number; message: string },
): Promise<unknown> {
  if (!schema) return value;
  const result = await schema["~standard"].validate(value);
  if (result.issues) throw new RpcError({ ...error, data: result.issues });
  return result.value;
}

const builder = <C extends Context, In = undefined, Out = Unset>(
  middlewares: Middleware<C>[] = [],
  inputSchema?: Schema<In>,
  outputSchema?: Schema,
): Builder<C, In, Out> =>
  // SAFETY: assigned methods exactly implement Builder; TypeScript cannot infer Object.assign's recursive generic shape.
  Object.assign(<T extends AnyRouter>(def: T): T => def, {
    use(mw: Middleware<C>) {
      return builder<C, In, Out>([...middlewares, mw], inputSchema, outputSchema);
    },
    input<Next>(schema: Schema<Next>) {
      return builder<C, Next, Out>(middlewares, schema, outputSchema);
    },
    output<Next>(schema: Schema<Next>) {
      return builder<C, In, Next>(middlewares, inputSchema, schema);
    },
    run(fn: (opts: { input: In; ctx: C; signal: AbortSignal }) => unknown) {
      const call = (async (input?: In, ctx?: C) => {
        const value = await parseWith(inputSchema, input, {
          code: JSON_RPC_ERROR.INVALID_PARAMS,
          message: "Invalid params",
        });
        const controller = new AbortController();
        const result = await applyMiddleware(middlewares, ctx ?? ({} as C), (nextCtx) =>
          fn({ input: value as In, ctx: nextCtx, signal: controller.signal }),
        );
        if (isAsyncGenerator(result)) {
          // Abort the procedure signal when its stream is closed (client
          // disconnect, batch cancel, or explicit .return()).
          const rawReturn = result.return.bind(result);
          const stream = Object.assign(result, {
            return: (closed?: unknown) => {
              controller.abort();
              return rawReturn(closed);
            },
          });
          if (!outputSchema) return stream;
          const wrapped = (async function* () {
            let next: unknown;
            for (;;) {
              const step = await stream.next(next);
              if (step.done) {
                if (step.value !== undefined) {
                  return await parseWith(outputSchema, step.value, {
                    code: JSON_RPC_ERROR.INTERNAL_ERROR,
                    message: "Invalid result",
                  });
                }
                return step.value;
              }
              next = yield await parseWith(outputSchema, step.value, {
                code: JSON_RPC_ERROR.INTERNAL_ERROR,
                message: "Invalid result",
              });
            }
          })();
          // Delegate close to `stream` first: `wrapped` is suspended at
          // stream.next(), which cannot settle until the signal aborts.
          const rawWrappedReturn = wrapped.return.bind(wrapped);
          return Object.assign(wrapped, {
            return: (closed?: unknown) => {
              void stream.return(closed).catch(() => {});
              return rawWrappedReturn(closed);
            },
          });
        }
        return parseWith(outputSchema, result, {
          code: JSON_RPC_ERROR.INTERNAL_ERROR,
          message: "Invalid result",
        });
      }) as ProcedureDef<C, In, unknown>;
      call.__rpc = true;
      call.inputSchema = inputSchema;
      call.outputSchema = outputSchema;
      call.middlewares = middlewares;
      call.run = fn as ProcedureDef<C, In, unknown>["run"];
      return call;
    },
  }) as unknown as Builder<C, In, Out>;

export const tacho = <C extends Context = {}>() => builder<C>();

export function resolveProcedure(router: AnyRouter, method: string) {
  if (!method || method.startsWith("rpc.")) return;
  let node: unknown = router;
  for (const segment of method.split(".")) {
    if (!node || typeof node !== "object" || !Object.hasOwn(node, segment)) return;
    node = (node as Record<string, unknown>)[segment];
  }
  return (node as ProcedureDef<any, any, any> | undefined)?.__rpc === true
    ? (node as ProcedureDef<any, any, any>)
    : undefined;
}

function errorResponse(
  code: number,
  message: string,
  id: JsonRpcId,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    error: data === undefined ? { code, message } : { code, message, data },
    id,
  };
}

function reply(notification: boolean, response: JsonRpcResponse): JsonRpcResponse | undefined {
  return notification ? undefined : response;
}

function isRequest(raw: unknown): raw is JsonRpcRequest {
  return (
    !!raw &&
    typeof raw === "object" &&
    (raw as JsonRpcRequest).jsonrpc === "2.0" &&
    typeof (raw as JsonRpcRequest).method === "string"
  );
}

function normalizeError(err: unknown) {
  if (err instanceof RpcError) {
    return { code: err.code, message: err.message, data: err.data };
  }
  return {
    code: JSON_RPC_ERROR.INTERNAL_ERROR,
    message: "Internal error",
  };
}

export type RpcStream = {
  __rpcStream: true;
  gen: AsyncGenerator<unknown, unknown>;
};

export const isRpcStream = (value: unknown): value is RpcStream =>
  !!value && typeof value === "object" && (value as RpcStream).__rpcStream === true;

const isAsyncGenerator = (value: unknown): value is AsyncGenerator<unknown, unknown> =>
  !!value &&
  typeof value === "object" &&
  typeof (value as AsyncGenerator<unknown, unknown>).next === "function" &&
  typeof (value as AsyncGenerator<unknown, unknown>)[Symbol.asyncIterator] === "function";

async function applyMiddleware<C extends Context>(
  middlewares: Middleware<C>[],
  ctx: C,
  run: (ctx: C) => unknown,
): Promise<unknown> {
  let i = 0;
  const next = async (opts?: { ctx: Partial<C> }) => {
    if (opts?.ctx) ctx = { ...ctx, ...opts.ctx };
    const mw = middlewares[i++];
    return mw ? mw({ ctx, next }) : run(ctx);
  };
  return next();
}

export async function runOne(
  router: AnyRouter,
  raw: unknown,
  ctx: Context,
  opts: { stream: true },
): Promise<JsonRpcResponse | RpcStream | undefined>;
export async function runOne(
  router: AnyRouter,
  raw: unknown,
  ctx: Context,
  opts?: { stream?: false },
): Promise<JsonRpcResponse | undefined>;
export async function runOne(
  router: AnyRouter,
  raw: unknown,
  ctx: Context,
  opts?: { stream?: boolean },
): Promise<JsonRpcResponse | RpcStream | undefined> {
  const fallbackId = (raw as { id?: JsonRpcId } | null)?.id ?? null;
  if (!isRequest(raw)) {
    return errorResponse(JSON_RPC_ERROR.INVALID_REQUEST, "Invalid Request", fallbackId);
  }

  const notification = raw.id === undefined;
  const procedure = resolveProcedure(router, raw.method);
  if (!procedure) {
    return reply(
      notification,
      errorResponse(JSON_RPC_ERROR.METHOD_NOT_FOUND, "Method not found", raw.id ?? null),
    );
  }

  try {
    const result = await procedure(raw.params, ctx);
    if (isAsyncGenerator(result)) {
      if (notification || !opts?.stream) {
        await result.return(undefined).catch(() => {});
        return notification
          ? undefined
          : errorResponse(
              JSON_RPC_ERROR.INTERNAL_ERROR,
              "Streaming is not supported",
              raw.id ?? null,
            );
      }
      return { __rpcStream: true, gen: result };
    }
    return reply(notification, {
      jsonrpc: "2.0",
      result: result ?? null,
      id: raw.id ?? null,
    });
  } catch (err) {
    const { code, message, data } = normalizeError(err);
    return reply(notification, errorResponse(code, message, raw.id ?? null, data));
  }
}

export async function runBatch(router: AnyRouter, items: unknown[], ctx: Context) {
  if (items.length === 0) {
    return errorResponse(JSON_RPC_ERROR.INVALID_REQUEST, "Invalid Request", null);
  }
  const results = await Promise.all(items.map((item) => runOne(router, item, { ...ctx })));
  const responses = results.filter((item): item is JsonRpcResponse => item !== undefined);
  return responses.length > 0 ? responses : undefined;
}

export type CallOptions = { signal?: AbortSignal };

type InferInput<T> =
  T extends ProcedureDef<any, infer In, any>
    ? undefined extends In
      ? [input?: In, opts?: CallOptions]
      : [input: In, opts?: CallOptions]
    : never;

type InferOutput<T> =
  T extends ProcedureDef<any, any, infer Out>
    ? Out extends AsyncGenerator<infer Y, infer R>
      ? AsyncGenerator<Y, R>
      : Out
    : never;

export type RPCClient<R> = {
  [K in keyof R]: R[K] extends ProcedureDef<any, any, any>
    ? (...args: InferInput<R[K]>) => Promise<InferOutput<R[K]>>
    : RPCClient<R[K]>;
};

export function createProxyClient<R, E extends object = {}>(
  send: (method: string, params: unknown, opts?: CallOptions) => Promise<unknown>,
  extras?: E,
): RPCClient<R> & E {
  const proxy = (path: string[]): RPCClient<R> & E =>
    // SAFETY: get/apply dynamically implement the recursive RPCClient surface TypeScript cannot model.
    new Proxy(() => {}, {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        if (path.length === 0 && extras && key in extras) return extras[key as keyof E];
        return proxy([...path, key]);
      },
      apply: (_target, _thisArg, args) => send(path.join("."), args[0], args[1]),
    }) as unknown as RPCClient<R> & E;
  return proxy([]);
}

export function rpcResult(body: {
  result?: unknown;
  error?: { message: string; code?: number; data?: unknown };
}) {
  if (body.error) {
    throw new RpcError({
      code: body.error.code ?? JSON_RPC_ERROR.INTERNAL_ERROR,
      message: body.error.message,
      data: body.error.data,
    });
  }
  return body.result;
}

export type OpenRpcInfo = {
  title: string;
  version: string;
  description?: string;
};

export type OpenRpcServer = { url: string; name?: string };

export type OpenRpcError = { code: number; message: string };

export type OpenRpcMethod = {
  name: string;
  params: { name: string; schema: unknown; required?: boolean }[];
  result: { name: string; schema: unknown };
  paramStructure?: "by-name" | "by-position" | "either";
  errors: OpenRpcError[];
};

export type OpenRpcDocument = {
  openrpc: string;
  info: OpenRpcInfo;
  methods: OpenRpcMethod[];
  servers?: OpenRpcServer[];
};

export type OpenRpcOptions = OpenRpcInfo & { servers?: OpenRpcServer[] };

const jsonSchema = (schema?: Schema) => {
  const vendor = schema?.["~standard"] as { vendor?: string; jsonSchema?: unknown } | undefined;
  return vendor?.jsonSchema ?? true;
};

const OPENRPC_ERRORS: OpenRpcError[] = [
  { code: JSON_RPC_ERROR.PARSE_ERROR, message: "Parse error" },
  { code: JSON_RPC_ERROR.INVALID_REQUEST, message: "Invalid Request" },
  { code: JSON_RPC_ERROR.METHOD_NOT_FOUND, message: "Method not found" },
  { code: JSON_RPC_ERROR.INVALID_PARAMS, message: "Invalid params" },
  { code: JSON_RPC_ERROR.INTERNAL_ERROR, message: "Internal error" },
  { code: APP_ERROR_RANGE.min, message: "Application error" },
];

export function toOpenRpc(
  router: AnyRouter,
  opts: OpenRpcOptions = { title: "tacho", version: "1.0.0" },
): OpenRpcDocument {
  const { servers, ...info } = opts;
  const methods: OpenRpcMethod[] = [];
  const walk = (node: AnyRouter, prefix: string) => {
    for (const [key, value] of Object.entries(node)) {
      const name = prefix ? `${prefix}.${key}` : key;
      if ((value as ProcedureDef<any, any, any>)?.__rpc === true) {
        const procedure = value as ProcedureDef<any, any, any>;
        methods.push({
          name,
          paramStructure: "by-name",
          params: procedure.inputSchema
            ? [{ name: "params", schema: jsonSchema(procedure.inputSchema), required: true }]
            : [],
          result: { name: "result", schema: jsonSchema(procedure.outputSchema) },
          errors: OPENRPC_ERRORS,
        });
      } else if (value && typeof value === "object") {
        walk(value as AnyRouter, name);
      }
    }
  };
  walk(router, "");
  return servers
    ? { openrpc: "1.3.2", info, methods, servers }
    : { openrpc: "1.3.2", info, methods };
}
