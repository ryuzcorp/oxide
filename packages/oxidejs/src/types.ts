export type OxidejsPreset = "fetch" | "worker";

/** JSON-compatible value used for opaque wrangler / env bags. */
export type OxidejsJson =
  | string
  | number
  | boolean
  | null
  | OxidejsJson[]
  | { [key: string]: OxidejsJson };

export interface OxidejsWranglerOptions {
  name: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  /** Cloudflare account id (wrangler deploy). Breaks `celld deploy` if present. */
  account_id?: string;
  /** Publish on `*.workers.dev` (Cloudflare). Breaks `celld deploy` if present. */
  workers_dev?: boolean;
  /** Cloudflare route patterns. Breaks `celld deploy` if present. */
  routes?: OxidejsJson[];
  d1_databases?: OxidejsJson[];
  durable_objects?: { [key: string]: OxidejsJson };
  migrations?: OxidejsJson[];
  kv_namespaces?: OxidejsJson[];
  r2_buckets?: OxidejsJson[];
  services?: OxidejsJson[];
  vars?: { [key: string]: OxidejsJson };
  /** Extra Cloudflare Workflow bindings. Scanned `workflow()` exports in `*.server.ts` are merged in. */
  workflows?: {
    binding: string;
    class_name: string;
    name: string;
    script_name?: string;
  }[];
  /**
   * Extra Cloudflare Queues producers/consumers. Scanned `queue()` exports in
   * `*.server.ts` are merged in. Same-worker consumers also export `fetch`
   * (actions): Cloudflare runs them; celld does not. Workflow-backed `send`
   * also starts the workflow from the producer so celld still progresses.
   */
  queues?: {
    consumers?: {
      dead_letter_queue?: string;
      max_batch_size?: number;
      max_batch_timeout?: number;
      max_retries?: number;
      queue: string;
    }[];
    producers?: {
      binding: string;
      queue: string;
    }[];
  };
  /**
   * Extra Cron triggers. Scanned `schedule()` exports in `*.server.ts` are
   * merged into `crons`.
   */
  triggers?: {
    crons?: string[];
  };
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
export type OxidejsActionHeaders =
  | { [key: string]: string }
  | [string, string][];

export interface OxidejsOptions {
  /**
   * `"fetch"` (default) skips wrangler.jsonc and serves client assets.
   * `"worker"` emits wrangler.jsonc for Cloudflare Workers.
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

  /** Wrangler config fields to merge into the generated wrangler.jsonc. */
  wrangler?: OxidejsWranglerOptions;

  /** Skip config emission. Defaults to false for worker, true for fetch. */
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
  env?: { [key: string]: OxidejsJson };
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
  env: { [key: string]: OxidejsJson } | undefined;
}
