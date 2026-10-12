/// <reference types="vite/client" />
/// <reference types="@cloudflare/workers-types" />

interface KitEnv {
  ASSETS?: Fetcher;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  /** D1 database from `cloudflare.config.ts` (`DB`). */
  DB?: D1Database;
  /** Emitted by oxide from `demo.server.ts` (`workflow()`). */
  DEMO?: Workflow;
  /** Emitted by oxide from `demo.server.ts` (`queue()`). */
  DEMOS?: Queue;
  /** R2 bucket from `cloudflare.config.ts` (`FILES`, unstorage driver). */
  FILES?: R2Bucket;
}
