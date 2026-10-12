// Worker config for the `cf` CLI — the single source for this Worker's
// bindings, assets, and defaults. oxide() loads it (Node ≥ 22.18; edits need
// a dev server restart) and withOxide() hands it to the Cloudflare plugin,
// and the build emits `dist/wrangler.json`, which the runner deploys with
// celld. Scanned durable bindings (workflows/queues/crons from
// `*.server.ts`) come from `oxideDurable` below: `withOxide()` merges them
// for plain `vite` builds, but the `cf` CLI build reads this file itself, so
// they must be declared here for `cf deploy`.
import { bindings, defineConfig, defineWorker } from "cf/config";
import { oxideDurable } from "oxidejs/cf";

const durable = oxideDurable(import.meta.dirname);

const worker = defineWorker({
  assets: {
    // Oxide's worker SPA-falls-back document navigations itself. Keep Assets
    // on real 404s — `single-page-application` would return index.html
    // (text/html) for a missing `/assets/*.js` and break hashed client
    // bundles after a deploy. Worker first so every path goes through it.
    notFoundHandling: "none",
    runWorkerFirst: true,
  },
  compatibilityDate: "2026-01-01",
  compatibilityFlags: ["nodejs_compat"],
  entrypoint: "./src/worker.ts",
  env: {
    // Oxide's worker wrapper serves the SPA through env.ASSETS; unlike
    // Cloudflare, celld does not inject it, so it is declared.
    ASSETS: bindings.assets(),
    // celld keys D1 by name (no database_id).
    DB: bindings.d1({ name: "kit" }),
    // celld also needs the bucket name.
    FILES: bindings.r2({ name: "files" }),
    ...durable.env,
  },
  exports: {
    ...durable.exports,
  },
  name: "kit",
  triggers: [...durable.triggers],
  workersDev: true,
});

export default defineConfig({ worker });
