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
}
