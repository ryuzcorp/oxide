export type OxidejsPreset = "fetch" | "celld";

export interface OxidejsWranglerOptions {
  name: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  durable_objects?: Record<string, unknown>;
  migrations?: unknown[];
  services?: unknown[];
  vars?: Record<string, unknown>;
}

export type OxidejsActionTransport = "http" | "ws";

/** `actions` config: transport string, or an object with `transport`, `path`, `sameOrigin`. */
export type OxidejsActions =
  | OxidejsActionTransport
  | {
      transport?: OxidejsActionTransport;
      /** Endpoint path for actions. Default: `/__oxide/action`. */
      path?: string;
      /** Reject cross-origin action requests (CSRF defense). Default: true. */
      sameOrigin?: boolean;
    };

/** Static headers inlined into the shared action client. Functions cannot ship to the browser. */
export type OxidejsActionHeaders = Record<string, string> | [string, string][];

export interface OxidejsOptions {
  /** "fetch" (default) skips wrangler.jsonc and serves client assets. "celld" emits wrangler.jsonc. */
  preset?: OxidejsPreset;

  /** Path to server entry, relative to project root. Default: "src/server.ts" */
  workerEntry?: string;

  /** Output root. Default: "dist" */
  outDir?: string;

  /** Client subdirectory under outDir. Default: "client" */
  clientDir?: string;

  /** Wrangler config fields to merge into the generated wrangler.jsonc. */
  wrangler?: OxidejsWranglerOptions;

  /** Skip config emission. Defaults to false for celld, true for fetch. */
  emitConfig?: boolean;

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

  /** Max request body size in bytes (Node preset). Larger requests get 413.
   * Default: 1048576 (1 MiB). */
  bodyLimit?: number;

  /** Custom 404 body (HTML) served when no route, asset, or user fetch
   * handled the request (fetch preset with client assets). */
  notFound?: string;

  /** Extra env passed as the second argument to fetch(request, env, ctx) on
   * the Node fetch preset — read it with useEnv(). */
  env?: Record<string, unknown>;
}

export interface ResolvedOptions {
  root: string;
  preset: OxidejsPreset;
  workerEntry: string;
  workerEntryAbs: string;
  /** Absolute output root. */
  outDir: string;
  /** Relative segment only. */
  clientDir: string;
  wrangler: OxidejsWranglerOptions | undefined;
  emitConfig: boolean;
  /** False when there is no index.html — server-only, no client env or assets. */
  hasClient: boolean;
  /** True when `<root>/public` exists. Copied next to client assets on fetch. */
  hasPublic: boolean;
  actions: OxidejsActionTransport;
  /** Endpoint path for actions. Default: `/__oxide/action`. */
  actionPath: string;
  /** Reject cross-origin action requests (CSRF defense). Default: true. */
  actionSameOrigin: boolean;
  actionHeaders: OxidejsActionHeaders | undefined;
  middleware: (string | { module: string; imports?: string[] })[];
  imports: string[];
  bodyLimit: number;
  notFound: string | undefined;
  env: Record<string, unknown> | undefined;
}
