export type OxidejsPreset = "fetch" | "worker";

/** JSON-compatible value used for opaque env bags. */
export type OxidejsJson =
  | string
  | number
  | boolean
  | null
  | OxidejsJson[]
  | { [key: string]: OxidejsJson };

export type OxidejsActionTransport = "http" | "ws";

/** `actions` config: transport string, or an object with `transport`, `path`, `sameOrigin`, `openrpc`. */
export type OxidejsActions =
  | OxidejsActionTransport
  | {
      transport?: OxidejsActionTransport;
      /** Endpoint path for actions. Default: `/__oxide/action`. */
      path?: string;
      /** Reject cross-origin action requests (CSRF defense). Default: true. */
      sameOrigin?: boolean;
      /**
       * Serve `GET /__oxide/openrpc` with an OpenRPC 1.3 document for
       * `action()` handlers only. Ignored when `transport` is `"ws"` (discovery
       * is HTTP). Default: false.
       */
      openrpc?: boolean;
    };

/** Static headers inlined into the shared action client. Functions cannot ship to the browser. */
export type OxidejsActionHeaders =
  | { [key: string]: string }
  | [string, string][];

/** Context passed to oxide build plugins. */
export interface OxideBuildContext {
  outDir: string;
  preset: OxidejsPreset;
  root: string;
}

/**
 * Oxide build plugin. Keep this surface small — Vite/Rsbuild adapters own
 * bundler-specific hooks; these only bracket the production build.
 */
export interface OxidePlugin {
  afterBuild?: (ctx: OxideBuildContext) => void | Promise<void>;
  beforeBuild?: (ctx: OxideBuildContext) => void | Promise<void>;
  name?: string;
}

/** Plugin instance or a module specifier that default-exports one. */
export type OxidePluginInput = OxidePlugin | string;

export interface OxidejsOptions {
  /**
   * `"fetch"` (Node) or `"worker"` (Cloudflare Workers companion).
   * Default: `"worker"` when `wrangler.jsonc` / `wrangler.toml` / `wrangler.json`
   * exists at the project root, otherwise `"fetch"`.
   */
  preset?: OxidejsPreset;

  /**
   * Path to server entry, relative to project root. Default: `"src/server.ts"`.
   * When the default path is missing, the entry is skipped (actions / assets only).
   * An explicit path that does not exist fails at build time.
   */
  workerEntry?: string;

  /** Output root. Default: "dist" */
  outDir?: string;

  /** Client subdirectory under outDir. Default: "client" */
  clientDir?: string;

  /** Transport and path for `*.server.ts` stubs. Default: `"http"` at `/__oxide/action`. */
  actions?: OxidejsActions;

  /** Extra headers on the shared HTTP action client. Ignored when `actions` is "ws". */
  actionHeaders?: OxidejsActionHeaders;

  /** Module specifiers whose default export is `(request, ctx) => Response | undefined | Promise<Response | undefined>`.
   * Tried in order at the top of the production fetch handler; a Response short-circuits.
   * Dev servers use connect middleware instead. */
  middleware?: (string | { module: string; imports?: string[] })[];

  /** Module specifiers imported for side effects at the top of the production
   * server bundle (e.g. virtual modules that self-register handlers). */
  imports?: string[];

  /** Max request body size in bytes (Node). Larger requests get 413.
   * Default: 1048576 (1 MiB). */
  bodyLimit?: number;

  /** Custom 404 body (HTML) served when no route, asset, or user fetch
   * handled the request (Node with client assets). */
  notFound?: string;

  /** Extra env passed as the second argument to fetch(request, env, ctx) on
   * Node — read it with useEnv(). */
  env?: { [key: string]: OxidejsJson };

  /**
   * Build plugins with `beforeBuild` / `afterBuild` hooks (production builds
   * only; once per build). Pass an object or a module specifier (default
   * export). Relative specifiers resolve against the Vite/Rsbuild project root.
   */
  plugins?: OxidePluginInput[];
}

export interface ResolvedOptions {
  root: string;
  preset: OxidejsPreset;
  workerEntry: string;
  workerEntryAbs: string;
  /** False when the default worker entry file is absent (actions-only). */
  hasWorkerEntry: boolean;
  /** Absolute output root. */
  outDir: string;
  /** Relative segment only. */
  clientDir: string;
  /** False when there is no index.html — server-only, no client env or assets. */
  hasClient: boolean;
  /** True when `<root>/public` exists. Copied next to client assets on Node. */
  hasPublic: boolean;
  actions: OxidejsActionTransport;
  /** Endpoint path for actions. Default: `/__oxide/action`. */
  actionPath: string;
  /** Reject cross-origin action requests (CSRF defense). Default: true. */
  actionSameOrigin: boolean;
  /** Serve OpenRPC discovery for `action()` handlers at `/__oxide/openrpc`. */
  actionOpenRpc: boolean;
  actionHeaders: OxidejsActionHeaders | undefined;
  middleware: (string | { module: string; imports?: string[] })[];
  imports: string[];
  bodyLimit: number;
  notFound: string | undefined;
  env: { [key: string]: OxidejsJson } | undefined;
  plugins: OxidePluginInput[];
}
