import { Effect, Layer, Scope, Stream } from "effect";
import type { Rpc } from "effect/unstable/rpc";
import { RpcClient, RpcGroup, RpcSchema, RpcSerialization } from "effect/unstable/rpc";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";
import type { OxidejsActionHeaders } from "../types";
import { streamToAsyncGen } from "./stream";

export type RpcClientOptions = {
  url: string;
  transport?: "http" | "ws";
  headers?: OxidejsActionHeaders;
};

type CallOptions = { signal?: AbortSignal };

type RpcCaller = (
  payload: { args: unknown[] },
  options?: CallOptions,
) => Effect.Effect<unknown, unknown, never> | Stream.Stream<unknown>;

type FlatClient = Record<string, RpcCaller>;

type NestedClient = Record<
  string,
  Record<string, (...args: unknown[]) => Promise<unknown> | AsyncGenerator<unknown>>
>;

type ActionGroup = RpcGroup.RpcGroup<Rpc.Any>;

type CacheEntry = {
  pending: Promise<NestedClient>;
};

const clientCache = new Map<string, CacheEntry>();
let nextGroupId = 0;

function cacheKey(group: ActionGroup, options: RpcClientOptions) {
  const headerKey = options.headers
    ? Object.entries(options.headers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("&")
    : "";
  let groupId = (group as { __oxideClientId?: number }).__oxideClientId;
  if (groupId === undefined) {
    groupId = ++nextGroupId;
    (group as { __oxideClientId?: number }).__oxideClientId = groupId;
  }
  return `${groupId}|${options.transport ?? "http"}|${options.url}|${headerKey}`;
}

function httpLayer(options: RpcClientOptions) {
  const headers = options.headers;
  return RpcClient.layerProtocolHttp({
    url: options.url,
    ...(headers
      ? {
          transformClient: <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
            HttpClient.mapRequest(client, (req) => {
              for (const [key, value] of Object.entries(headers)) {
                req = HttpClientRequest.setHeader(req, key, value);
              }
              return req;
            }),
        }
      : {}),
  }).pipe(Layer.provide(RpcSerialization.layerNdJsonRpc()), Layer.provide(FetchHttpClient.layer));
}

function wsLayer(url: string) {
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(RpcSerialization.layerNdJsonRpc()),
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
}

function clientLayer(options: RpcClientOptions) {
  return options.transport === "ws" ? wsLayer(options.url) : httpLayer(options);
}

function loadClient(group: ActionGroup, options: RpcClientOptions) {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    return yield* Scope.provide(scope)(
      RpcClient.make(group).pipe(Effect.provide(clientLayer(options))),
    );
  });
}

function isStreamResult(value: unknown): value is Stream.Stream<unknown> {
  return Stream.isStream(value);
}

function isStreamTag(group: ActionGroup, tag: string) {
  const rpc = group.requests.get(tag) as { successSchema?: unknown } | undefined;
  if (!rpc?.successSchema) return false;
  return RpcSchema.isStreamSchema(rpc.successSchema as never);
}

function streamToAsyncGenerator<T>(stream: Stream.Stream<T>, signal?: AbortSignal) {
  const iterable = streamToAsyncGen(stream);
  return (async function* () {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const iterator = iterable[Symbol.asyncIterator]();
    const onAbort = () => {
      void iterator.return?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const next = await iterator.next();
        if (next.done) return undefined as undefined;
        yield next.value;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  })();
}

function callFlat(client: FlatClient, tag: string, args: unknown[], callOpts?: CallOptions) {
  const caller = client[tag];
  if (!caller) return Promise.reject(new Error(`Unknown action ${tag}`));
  const result = caller({ args }, callOpts);
  if (isStreamResult(result)) {
    return streamToAsyncGenerator(result, callOpts?.signal);
  }
  return Effect.runPromise(result as Effect.Effect<unknown>, { signal: callOpts?.signal });
}

function nestClient(group: ActionGroup, flat: FlatClient): NestedClient {
  const nested: NestedClient = {};
  for (const tag of group.requests.keys()) {
    const dot = tag.indexOf(".");
    if (dot === -1) continue;
    const mod = tag.slice(0, dot);
    const name = tag.slice(dot + 1);
    nested[mod] ??= {};
    nested[mod][name] = (...args: unknown[]) => {
      const opts = args.at(-1);
      const hasSignal =
        opts &&
        typeof opts === "object" &&
        "signal" in opts &&
        opts.signal instanceof AbortSignal &&
        Object.keys(opts).length === 1;
      const params = hasSignal ? args.slice(0, -1) : args;
      const callOpts = hasSignal ? (opts as CallOptions) : undefined;
      return callFlat(flat, tag, params, callOpts);
    };
  }
  return nested;
}

export function createClient(group: ActionGroup, options: RpcClientOptions): NestedClient {
  const key = cacheKey(group, options);
  let entry = clientCache.get(key);
  if (!entry) {
    const pending = Effect.runPromise(loadClient(group, options))
      .then((flat) => nestClient(group, flat as unknown as FlatClient))
      .catch((error) => {
        clientCache.delete(key);
        throw error;
      });
    entry = { pending };
    clientCache.set(key, entry);
  }

  return new Proxy({} as NestedClient, {
    get(_target, mod) {
      if (typeof mod !== "string") return undefined;
      return new Proxy(
        {},
        {
          get(_inner, name) {
            if (typeof name !== "string") return undefined;
            const tag = `${mod}.${name}`;
            if (isStreamTag(group, tag)) {
              return (...args: unknown[]) =>
                (async function* () {
                  const client = await entry!.pending;
                  const out = client[mod]?.[name]?.(...args);
                  if (!out) throw new Error(`Unknown action ${mod}.${name}`);
                  yield* out as AsyncGenerator<unknown>;
                })();
            }
            return (...args: unknown[]) =>
              entry!.pending.then(
                (client) =>
                  (client[mod]?.[name]?.(...args) as Promise<unknown>) ??
                  Promise.reject(new Error(`Unknown action ${mod}.${name}`)),
              );
          },
        },
      );
    },
  });
}
