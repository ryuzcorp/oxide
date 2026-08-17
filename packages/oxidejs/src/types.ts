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

  /** Transport for `*.server.ts` stubs. Default: "http". */
  actions?: OxidejsActionTransport;

  /** Extra headers on the shared HTTP action client. Ignored when `actions` is "ws". */
  actionHeaders?: OxidejsActionHeaders;
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
  actionHeaders: OxidejsActionHeaders | undefined;
}
