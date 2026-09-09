/// <reference types="vite/client" />
/// <reference types="@cloudflare/workers-types" />

interface KitEnv {
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  DB?: D1Database;
  /** Emitted by oxide from `demo.server.ts` (`workflow()`). */
  DEMO?: Workflow;
  /** Emitted by oxide from `demo.server.ts` (`queue()`). */
  DEMOS?: Queue;
  /** R2 bucket from wrangler `r2_buckets` (unstorage driver). */
  FILES?: R2Bucket;
}
