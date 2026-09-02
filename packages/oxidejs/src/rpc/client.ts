import { Effect, Layer, Scope, Stream } from "effect";
import type { Rpc } from "effect/unstable/rpc";
import { RpcClient, RpcGroup, RpcSerialization } from "effect/unstable/rpc";
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

type NestedClient = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;

type ActionGroup = RpcGroup.RpcGroup<Rpc.Any>;

function withSignal<A>(promise: Promise<A>, signal?: AbortSignal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<A>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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
  }).pipe(Layer.provide(RpcSerialization.layerJsonRpc()), Layer.provide(FetchHttpClient.layer));
}

function wsLayer(url: string) {
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(RpcSerialization.layerJsonRpc()),
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
}

function clientLayer(options: RpcClientOptions) {
  return options.transport === "ws" ? wsLayer(options.url) : httpLayer(options);
}

const clientCache = new WeakMap<ActionGroup, Promise<NestedClient>>();
const clientScopes = new WeakMap<ActionGroup, Scope.Scope>();

function loadClient(group: ActionGroup, options: RpcClientOptions) {
  return Effect.gen(function* () {
    let scope = clientScopes.get(group);
    if (!scope) {
      scope = yield* Scope.make();
      clientScopes.set(group, scope);
    }
    return yield* Scope.provide(scope)(
      RpcClient.make(group).pipe(Effect.provide(clientLayer(options))),
    );
  });
}

function isStreamResult(value: unknown): value is Stream.Stream<unknown> {
  return Stream.isStream(value);
}

function streamToAsyncGenerator<T>(stream: Stream.Stream<T>) {
  const iterable = streamToAsyncGen(stream);
  return (async function* () {
    for await (const value of iterable) yield value;
    return undefined;
  })();
}

function callFlat(client: FlatClient, tag: string, args: unknown[], callOpts?: CallOptions) {
  const caller = client[tag];
  if (!caller) return Promise.reject(new Error(`Unknown action ${tag}`));
  const result = caller({ args }, callOpts);
  if (isStreamResult(result)) {
    return withSignal(Promise.resolve(streamToAsyncGenerator(result)), callOpts?.signal);
  }
  return withSignal(Effect.runPromise(result), callOpts?.signal);
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
  const pending =
    clientCache.get(group) ??
    Effect.runPromise(loadClient(group, options)).then((flat) =>
      nestClient(group, flat as unknown as FlatClient),
    );
  clientCache.set(group, pending);

  return new Proxy({} as NestedClient, {
    get(_target, mod) {
      if (typeof mod !== "string") return undefined;
      return new Proxy(
        {},
        {
          get(_inner, name) {
            if (typeof name !== "string") return undefined;
            return (...args: unknown[]) =>
              pending.then(
                (client) =>
                  client[mod]?.[name]?.(...args) ??
                  Promise.reject(new Error(`Unknown action ${mod}.${name}`)),
              );
          },
        },
      );
    },
  });
}
