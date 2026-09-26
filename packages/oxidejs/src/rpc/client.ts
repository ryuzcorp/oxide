import { Cause, Effect, Layer, Scope, Stream } from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import type { Rpc, RpcGroup, RpcMessage } from "effect/unstable/rpc";
import {
  RpcClient,
  RpcClientError,
  RpcSchema,
  RpcSerialization,
} from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";

import type { OxidejsActionHeaders } from "../types";
import { registerBatchFlusher, scheduleBatchFlush } from "./batch";
import { NDJSON_CONTENT } from "./scrub";
import { streamToAsyncGen } from "./stream";

export interface RpcClientOptions {
  headers?: OxidejsActionHeaders;
  transport?: "http" | "ws";
  url: string;
}

interface CallOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** Opaque action argument values (JSON-ish plus call options bags). */
type ActionCallArg =
  | string
  | number
  | boolean
  | null
  | ActionCallArg[]
  | { [key: string]: ActionCallArg }
  | CallOptions
  | AbortSignal;

/** Values returned from an action call before nesting. */
type ActionCallResult =
  | string
  | number
  | boolean
  | null
  | object
  | undefined
  | AsyncGenerator<ActionCallResult>;

type RpcCaller = (
  payload: { args: ActionCallArg[] },
  options?: { headers?: { [key: string]: string } }
) =>
  | Effect.Effect<ActionCallResult, Error, never>
  | Stream.Stream<ActionCallResult>;

type FlatClient = Record<string, RpcCaller>;

/** Client surface exposed by {@link createClient}: one callable per RPC tag. */
export type NestedClient = Record<
  string,
  Record<
    string,
    (
      ...args: ActionCallArg[]
    ) => Promise<ActionCallResult> | AsyncGenerator<ActionCallResult>
  >
>;

type ActionGroup = RpcGroup.RpcGroup<Rpc.Any>;

interface OxideClientGroup {
  __oxideClientId?: number;
}

interface CacheEntry {
  pending: Promise<NestedClient>;
}

interface RpcRequestMeta {
  successSchema?: object;
}

const clientCache = new Map<string, CacheEntry>();
let nextGroupId = 0;

const isStringPropertyKey = function isStringPropertyKey(
  key: string | symbol
): key is string {
  return typeof key === "string";
};

interface ActionHeaderMap {
  [key: string]: string;
}

const normalizeActionHeaders = function normalizeActionHeaders(
  headers: OxidejsActionHeaders
): ActionHeaderMap {
  if (Array.isArray(headers)) {
    const out: ActionHeaderMap = {};
    for (const [key, value] of headers) {
      out[key] = value;
    }
    return out;
  }
  return headers;
};

const cacheKey = function cacheKey(
  group: ActionGroup,
  options: RpcClientOptions
) {
  let headerKey = "";
  if (options.headers) {
    const entries = Object.entries(normalizeActionHeaders(options.headers));
    // oxlint-disable-next-line unicorn/no-array-sort -- Array#toSorted needs ES2023 lib; entries is already a copy
    entries.sort(([a], [b]) => a.localeCompare(b));
    headerKey = entries.map(([k, v]) => `${k}=${v}`).join("&");
  }
  // SAFETY: groups are mutable objects we stamp with a stable client cache id.
  const stamped = group as ActionGroup & OxideClientGroup;
  let groupId = stamped.__oxideClientId;
  if (groupId === undefined) {
    nextGroupId += 1;
    groupId = nextGroupId;
    stamped.__oxideClientId = groupId;
  }
  return `${groupId}|${options.transport ?? "http"}|${options.url}|${headerKey}`;
};

interface QueuedRequest {
  clientId: number;
  request: RpcMessage.FromClientEncoded & { _tag: "Request" };
}

const rpcClientError = function rpcClientError(
  message: string,
  cause: unknown
): RpcClientError.RpcClientError {
  return new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({ cause, message }),
  });
};

const isStreamTag = function isStreamTag(group: ActionGroup, tag: string) {
  // SAFETY: Effect request map values expose optional successSchema used by isStreamSchema.
  const rpc = group.requests.get(tag) as RpcRequestMeta | undefined;
  if (!rpc?.successSchema) {
    return false;
  }
  // SAFETY: isStreamSchema accepts Effect schema values; successSchema is that schema object.
  return RpcSchema.isStreamSchema(rpc.successSchema as never);
};

/**
 * Encode one JSON-RPC request — or a JSON-RPC 2.0 batch array — as a POST body.
 */
const batchBody = function batchBody(
  requests: RpcMessage.RequestEncoded[]
): string {
  const encoder = RpcSerialization.jsonRpc().makeUnsafe();
  const single = requests.length === 1 ? requests[0] : undefined;
  // SAFETY: the jsonRpc codec always encodes requests to JSON text; the shared
  // `encode` signature also covers binary serializations.
  const encoded = (
    single === undefined ? encoder.encode(requests) : encoder.encode(single)
  ) as string | undefined;
  return encoded ?? "";
};

/**
 * HTTP transport that queues unary requests and posts them as one JSON-RPC 2.0
 * batch. Stream requests bypass the queue: they need incremental framing and
 * fetch abort on interrupt.
 */
const makeBatchProtocol = function makeBatchProtocol(
  group: ActionGroup,
  options: RpcClientOptions
) {
  return RpcClient.Protocol.make(
    Effect.fnUntraced(function* makeBatchProtocolGen(writeResponse) {
      const scope = yield* Effect.scope;
      const http = yield* HttpClient.HttpClient;
      const headerMap = options.headers
        ? normalizeActionHeaders(options.headers)
        : undefined;
      const queued: QueuedRequest[] = [];

      const failQueued = function failQueued(
        entries: QueuedRequest[],
        message: string,
        cause?: unknown
      ) {
        const error = rpcClientError(message, cause);
        return Effect.forEach(
          entries,
          (entry) =>
            writeResponse(entry.clientId, {
              _tag: "ClientProtocolError",
              error,
            }),
          { discard: true }
        );
      };

      const post = function post(entries: QueuedRequest[]) {
        return Effect.gen(function* postGen() {
          // One parser per request: its line buffer must not mix with other POSTs.
          const parser = RpcSerialization.ndJsonRpc().makeUnsafe();
          const requests = entries.map((entry) => entry.request);
          const body = batchBody(requests);

          let request = HttpClientRequest.post(options.url, {
            body: HttpBody.text(body, NDJSON_CONTENT),
          });
          for (const [key, value] of Object.entries(headerMap ?? {})) {
            request = HttpClientRequest.setHeader(request, key, value);
          }

          const clientByRequestId = new Map(
            entries.map((entry) => [String(entry.request.id), entry.clientId])
          );
          const unsettled = new Set(clientByRequestId.keys());
          const settle = function settle(
            requestId: string
          ): number | undefined {
            const clientId = clientByRequestId.get(requestId);
            if (clientId !== undefined) {
              unsettled.delete(requestId);
            }
            return clientId;
          };

          const executed = yield* Effect.exit(http.execute(request));
          if (executed._tag === "Failure") {
            return yield* failQueued(
              entries,
              "RPC request failed",
              Cause.squash(executed.cause)
            );
          }

          const read = yield* Effect.exit(
            Stream.runForEachArray(executed.value.stream, (chunks) => {
              // SAFETY: parser.decode yields transport-decoded RPC messages.
              const messages = chunks.flatMap((chunk) =>
                parser.decode(chunk)
              ) as RpcMessage.FromServerEncoded[];
              return Effect.forEach(
                messages,
                (message) => {
                  if (message._tag === "Defect") {
                    unsettled.clear();
                    return Effect.forEach(
                      entries,
                      (entry) => writeResponse(entry.clientId, message),
                      { discard: true }
                    );
                  }
                  if (!("requestId" in message)) {
                    return Effect.void;
                  }
                  const requestId = String(message.requestId);
                  const clientId = settle(requestId);
                  if (clientId === undefined) {
                    return Effect.void;
                  }
                  return writeResponse(clientId, message);
                },
                { discard: true }
              );
            })
          );

          const unfinished = entries.filter((entry) =>
            unsettled.has(String(entry.request.id))
          );
          if (unfinished.length === 0) {
            return;
          }
          if (read._tag === "Failure") {
            return yield* failQueued(
              unfinished,
              "Error reading RPC response",
              Cause.squash(read.cause)
            );
          }
          yield* failQueued(
            unfinished,
            "HTTP response ended before RPC request completed"
          );
        });
      };

      const flush = async function flush(): Promise<void> {
        if (queued.length === 0) {
          return;
        }
        const entries = queued.splice(0);
        await Effect.runPromise(post(entries));
      };

      const unregister = registerBatchFlusher({
        flush,
        queued: () => queued.length,
      });
      yield* Scope.addFinalizer(scope, Effect.sync(unregister));

      return {
        codecFor: RpcSerialization.ndJsonRpc().codecFor,
        send(clientId, request) {
          if (request._tag === "Interrupt") {
            // Aborted before it was posted — never put it on the wire.
            const index = queued.findIndex(
              (entry) => entry.request.id === request.requestId
            );
            if (index !== -1) {
              queued.splice(index, 1);
            }
            return Effect.void;
          }
          if (request._tag !== "Request") {
            return Effect.void;
          }
          if (isStreamTag(group, request.tag)) {
            return post([{ clientId, request }]);
          }
          queued.push({ clientId, request });
          scheduleBatchFlush();
          return Effect.void;
        },
        supportsAck: false,
        supportsTransferables: false,
      };
    })
  );
};

const httpLayer = function httpLayer(
  group: ActionGroup,
  options: RpcClientOptions
) {
  return Layer.effect(RpcClient.Protocol)(
    makeBatchProtocol(group, options)
  ).pipe(Layer.provide(FetchHttpClient.layer));
};

const wsLayer = function wsLayer(url: string) {
  return RpcClient.layerProtocolSocket({
    retryTransientErrors: true,
  }).pipe(
    Layer.provide(RpcSerialization.layerNdJsonRpc()),
    Layer.provide(
      Socket.layerWebSocket(url, {
        // 1000 normal / 1001 going away are reconnectable; don't fail the run as a hard error.
        closeCodeIsError: (code) => code !== 1000 && code !== 1001,
      })
    ),
    Layer.provide(Socket.layerWebSocketConstructorGlobal)
  );
};

const clientLayer = function clientLayer(
  group: ActionGroup,
  options: RpcClientOptions
) {
  return options.transport === "ws"
    ? wsLayer(options.url)
    : httpLayer(group, options);
};

const loadClient = function loadClient(
  group: ActionGroup,
  options: RpcClientOptions
) {
  return Effect.gen(function* loadClientGen() {
    const scope = yield* Scope.make();
    // Build the layer inside the long-lived scope and provide its Context.
    // `Effect.provide(layer)` builds in a transient scope that closes as soon as
    // `RpcClient.make` returns — killing the socket protocol's forked read loop
    // before it ever dials, so every WS action call hangs forever.
    const context = yield* Scope.provide(scope)(
      Layer.build(clientLayer(group, options))
    );
    return yield* Scope.provide(scope)(
      RpcClient.make(group).pipe(Effect.provide(context))
    );
  });
};

const isStreamResult = function isStreamResult(
  value:
    | Effect.Effect<ActionCallResult, Error, never>
    | Stream.Stream<ActionCallResult>
): value is Stream.Stream<ActionCallResult> {
  return Stream.isStream(value);
};

const streamToAsyncGenerator = function streamToAsyncGenerator<T>(
  stream: Stream.Stream<T>,
  signal?: AbortSignal
) {
  const iterable = streamToAsyncGen(stream);
  return (async function* streamProxy() {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const iterator = iterable[Symbol.asyncIterator]();
    const onAbort = function onAbort() {
      void iterator.return?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const pull = async function* pull(): AsyncGenerator<T> {
      for (;;) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        // Sequential iterator pull — must await each step before the next.
        // oxlint-disable-next-line eslint/no-await-in-loop -- async iterator is ordered
        const next = await iterator.next();
        if (next.done) {
          return;
        }
        yield next.value;
      }
    };

    try {
      yield* pull();
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  })();
};

const TRANSIENT_CLOSE = /\b(?:1000|1001|1006)\b/u;

/** Socket close / open races that the Effect WS protocol recovers from. */
const isTransientWsClose = function isTransientWsClose(error: Error) {
  const chunks: string[] = [];
  let current: Error | undefined = error;
  const seen = new Set<Error>();
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    chunks.push(current.name, current.message);
    const nested: unknown = current.cause;
    current = nested instanceof Error ? nested : undefined;
  }
  const text = chunks.join(" ");
  if (/SocketOpenError/u.test(text)) {
    return true;
  }
  return /SocketCloseError/u.test(text) && TRANSIENT_CLOSE.test(text);
};

const isAbortError = function isAbortError(error: Error, signal?: AbortSignal) {
  if (signal?.aborted) {
    return true;
  }
  return error instanceof DOMException && error.name === "AbortError";
};

const sleep = function sleep(ms: number) {
  return Effect.runPromise(Effect.sleep(`${ms} millis`));
};

const IDEMPOTENCY_HEADER = "x-oxide-idempotency-key";

const callFlat = function callFlat(
  client: FlatClient,
  tag: string,
  args: ActionCallArg[],
  callOpts?: CallOptions
) {
  const caller = client[tag];
  if (!caller) {
    return Promise.reject(new Error(`Unknown action ${tag}`));
  }
  const rpcOpts =
    callOpts?.idempotencyKey === undefined
      ? undefined
      : { headers: { [IDEMPOTENCY_HEADER]: callOpts.idempotencyKey } };
  const result = caller({ args }, rpcOpts);
  if (isStreamResult(result)) {
    return streamToAsyncGenerator(result, callOpts?.signal);
  }
  // SAFETY: non-stream RpcCaller results are Effects runnable via Effect.runPromise.
  return Effect.runPromise(result as Effect.Effect<ActionCallResult>, {
    signal: callOpts?.signal,
  });
};

const callFlatStreamResilient = function callFlatStreamResilient(
  client: FlatClient,
  tag: string,
  args: ActionCallArg[],
  callOpts?: CallOptions
) {
  return (async function* resilientStream(): AsyncGenerator<ActionCallResult> {
    let attempt = 0;
    for (;;) {
      if (callOpts?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      try {
        // SAFETY: stream branch of callFlat always returns AsyncGenerator.
        yield* callFlat(
          client,
          tag,
          args,
          callOpts
        ) as AsyncGenerator<ActionCallResult>;
        return;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (isAbortError(err, callOpts?.signal) || !isTransientWsClose(err)) {
          throw error;
        }
        attempt += 1;
        // oxlint-disable-next-line eslint/no-await-in-loop -- backoff between reconnect attempts
        await sleep(Math.min(50 * 2 ** (attempt - 1), 2000));
      }
    }
  })();
};

const isCallOptions = function isCallOptions(
  value: ActionCallArg
): value is CallOptions {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  if (value instanceof AbortSignal) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > 2) {
    return false;
  }
  for (const key of keys) {
    if (key !== "signal" && key !== "idempotencyKey") {
      return false;
    }
  }
  // SAFETY: keys are only CallOptions fields; validate value shapes.
  const bag = value as CallOptions;
  if ("signal" in bag && !(bag.signal instanceof AbortSignal)) {
    return false;
  }
  if (
    "idempotencyKey" in bag &&
    bag.idempotencyKey !== undefined &&
    typeof bag.idempotencyKey !== "string"
  ) {
    return false;
  }
  return "signal" in bag || "idempotencyKey" in bag;
};

const nestClient = function nestClient(group: ActionGroup, flat: FlatClient) {
  const nested: NestedClient = {};
  for (const tag of group.requests.keys()) {
    const dot = tag.indexOf(".");
    if (dot === -1) {
      continue;
    }
    const mod = tag.slice(0, dot);
    const name = tag.slice(dot + 1);
    nested[mod] ??= {};
    nested[mod][name] = (...args: ActionCallArg[]) => {
      const opts = args.at(-1);
      const hasSignal = opts !== undefined && isCallOptions(opts);
      const params = hasSignal ? args.slice(0, -1) : args;
      const callOpts = hasSignal ? opts : undefined;
      if (isStreamTag(group, tag)) {
        return callFlatStreamResilient(flat, tag, params, callOpts);
      }
      return callFlat(flat, tag, params, callOpts);
    };
  }
  return nested;
};

export const createClient = function createClient(
  group: ActionGroup,
  options: RpcClientOptions
) {
  const key = cacheKey(group, options);
  let entry = clientCache.get(key);
  if (!entry) {
    const pending = (async function loadNestedClient() {
      try {
        const flat = await Effect.runPromise(loadClient(group, options));
        // SAFETY: RpcClient.make yields a tag-keyed service; never bridges Effect's generated client to FlatClient.
        return nestClient(group, flat as never);
      } catch (error) {
        clientCache.delete(key);
        throw error;
      }
    })();
    entry = { pending };
    clientCache.set(key, entry);
  }

  const cached = entry;

  // SAFETY: empty target; NestedClient shape is enforced by the get traps below.
  return new Proxy({} as NestedClient, {
    get(_target, mod) {
      if (!isStringPropertyKey(mod)) {
        return;
      }
      return new Proxy(
        {},
        {
          get(_inner, name) {
            if (!isStringPropertyKey(name)) {
              return;
            }
            const tag = `${mod}.${name}`;
            if (isStreamTag(group, tag)) {
              return (...args: ActionCallArg[]) =>
                (async function* streamAction() {
                  const client = await cached.pending;
                  const out = client[mod]?.[name]?.(...args);
                  if (!out) {
                    throw new Error(`Unknown action ${mod}.${name}`);
                  }
                  // SAFETY: stream actions return AsyncGenerator from callFlat.
                  yield* out as AsyncGenerator<ActionCallResult>;
                })();
            }
            return async (...args: ActionCallArg[]) => {
              const client = await cached.pending;
              const out = client[mod]?.[name]?.(...args);
              if (!out) {
                throw new Error(`Unknown action ${mod}.${name}`);
              }
              return out;
            };
          },
        }
      );
    },
  });
};
