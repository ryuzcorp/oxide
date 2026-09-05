import { Effect, Layer, Scope, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import type { Rpc, RpcGroup } from "effect/unstable/rpc";
import { RpcClient, RpcSchema, RpcSerialization } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";

import type { OxidejsActionHeaders } from "../types";
import { streamToAsyncGen } from "./stream";

export interface RpcClientOptions {
  headers?: OxidejsActionHeaders;
  transport?: "http" | "ws";
  url: string;
}

interface CallOptions {
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
  options?: CallOptions
) =>
  | Effect.Effect<ActionCallResult, Error, never>
  | Stream.Stream<ActionCallResult>;

type FlatClient = Record<string, RpcCaller>;

type NestedClient = Record<
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

const cacheKey = function cacheKey(
  group: ActionGroup,
  options: RpcClientOptions
) {
  let headerKey = "";
  if (options.headers) {
    const entries = Object.entries(options.headers);
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

const httpLayer = function httpLayer(options: RpcClientOptions) {
  const { headers } = options;
  if (!headers) {
    return RpcClient.layerProtocolHttp({
      url: options.url,
    }).pipe(
      Layer.provide(RpcSerialization.layerNdJsonRpc()),
      Layer.provide(FetchHttpClient.layer)
    );
  }

  return RpcClient.layerProtocolHttp({
    transformClient: <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
      HttpClient.mapRequest(client, (req) => {
        let next = req;
        for (const [key, value] of Object.entries(headers)) {
          next = HttpClientRequest.setHeader(next, key, value);
        }
        return next;
      }),
    url: options.url,
  }).pipe(
    Layer.provide(RpcSerialization.layerNdJsonRpc()),
    Layer.provide(FetchHttpClient.layer)
  );
};

const wsLayer = function wsLayer(url: string) {
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(RpcSerialization.layerNdJsonRpc()),
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal)
  );
};

const clientLayer = function clientLayer(options: RpcClientOptions) {
  return options.transport === "ws" ? wsLayer(options.url) : httpLayer(options);
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
      Layer.build(clientLayer(options))
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

const isStreamTag = function isStreamTag(group: ActionGroup, tag: string) {
  // SAFETY: Effect request map values expose optional successSchema used by isStreamSchema.
  const rpc = group.requests.get(tag) as RpcRequestMeta | undefined;
  if (!rpc?.successSchema) {
    return false;
  }
  // SAFETY: isStreamSchema accepts Effect schema values; successSchema is that schema object.
  return RpcSchema.isStreamSchema(rpc.successSchema as never);
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
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const next = await iterator.next();
      if (next.done) {
        return;
      }
      yield next.value;
      yield* pull();
    };

    try {
      yield* pull();
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  })();
};

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
  const result = caller({ args }, callOpts);
  if (isStreamResult(result)) {
    return streamToAsyncGenerator(result, callOpts?.signal);
  }
  // SAFETY: non-stream RpcCaller results are Effects runnable via Effect.runPromise.
  return Effect.runPromise(result as Effect.Effect<ActionCallResult>, {
    signal: callOpts?.signal,
  });
};

const isCallOptions = function isCallOptions(
  value: ActionCallArg
): value is CallOptions {
  return (
    value !== null &&
    typeof value === "object" &&
    "signal" in value &&
    value.signal instanceof AbortSignal &&
    Object.keys(value).length === 1
  );
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
