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

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor({ code, message, data }: { code: number; message: string; data?: unknown }) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

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
  middlewares: Middleware<C>[];
  run: (opts: { input: In; ctx: C }) => Out | Promise<Out>;
};

export type AnyRouter = {
  [key: string]: ProcedureDef<any, any, any> | AnyRouter;
};

export const router = <T extends AnyRouter>(def: T): T => def;

type Builder<C extends Context, In = undefined> = {
  <T extends AnyRouter>(def: T): T;
  use(mw: Middleware<C>): Builder<C, In>;
  input<Out>(schema: Schema<Out>): Builder<C, Out>;
  run<Out>(fn: (opts: { input: In; ctx: C }) => Out | Promise<Out>): ProcedureDef<C, In, Out>;
};

const builder = <C extends Context, In = undefined>(
  middlewares: Middleware<C>[] = [],
  inputSchema?: Schema<In>,
): Builder<C, In> =>
  Object.assign(<T extends AnyRouter>(def: T): T => def, {
    use(mw: Middleware<C>) {
      return builder<C, In>([...middlewares, mw], inputSchema);
    },
    input<Out>(schema: Schema<Out>) {
      return builder<C, Out>(middlewares, schema);
    },
    run<Out>(fn: (opts: { input: In; ctx: C }) => Out | Promise<Out>): ProcedureDef<C, In, Out> {
      const call = (async (input?: In, ctx?: C) => {
        let value: unknown = input;
        if (inputSchema) {
          const result = await inputSchema["~standard"].validate(value);
          if (result.issues) {
            throw new RpcError({
              code: JSON_RPC_ERROR.INVALID_PARAMS,
              message: "Invalid params",
              data: result.issues,
            });
          }
          value = result.value;
        }
        return applyMiddleware(middlewares, ctx ?? ({} as C), (nextCtx) =>
          fn({ input: value as In, ctx: nextCtx }),
        ) as Promise<Out>;
      }) as ProcedureDef<C, In, Out>;
      call.__rpc = true;
      call.inputSchema = inputSchema;
      call.middlewares = middlewares;
      call.run = fn;
      return call;
    },
  });

export const tacho = <C extends Context = {}>() => builder<C>();

export function resolveProcedure(router: AnyRouter, method: string) {
  if (!method || method.startsWith("rpc.")) return;
  let node: unknown = router;
  for (const segment of method.split(".")) {
    if (!node || typeof node !== "object") return;
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
    message: err instanceof Error ? err.message : "Internal error",
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
      errorResponse(
        JSON_RPC_ERROR.METHOD_NOT_FOUND,
        `Method not found: ${raw.method}`,
        raw.id ?? null,
      ),
    );
  }

  try {
    let input: unknown = raw.params;
    if (procedure.inputSchema) {
      const result = await procedure.inputSchema["~standard"].validate(input);
      if (result.issues) {
        return reply(
          notification,
          errorResponse(
            JSON_RPC_ERROR.INVALID_PARAMS,
            "Invalid params",
            raw.id ?? null,
            result.issues,
          ),
        );
      }
      input = result.value;
    }

    const result = await applyMiddleware(procedure.middlewares, ctx, (nextCtx) =>
      procedure.run({ input, ctx: nextCtx }),
    );
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
  const results = await Promise.all(
    items.map((item) => runOne(router, item, ctx, { stream: true })),
  );
  if (results.some(isRpcStream)) {
    await Promise.all(
      results.map((item) =>
        isRpcStream(item) ? item.gen.return(undefined).catch(() => {}) : undefined,
      ),
    );
    return errorResponse(JSON_RPC_ERROR.INVALID_REQUEST, "Invalid Request", null);
  }
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
    throw Object.assign(new Error(body.error.message), {
      code: body.error.code,
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
          result: { name: "result", schema: true },
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
