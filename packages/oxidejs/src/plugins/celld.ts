import fs from "node:fs";
import path from "node:path";

import type { OxidePlugin } from "../types";
import { prepareCelldDeploy } from "../wrangler";

/** Opt-in gate so Cloudflare `wrangler deploy` is not polluted by celld artifacts. */
export const isCelldPrepareEnabled = function isCelldPrepareEnabled(
  env: { [key: string]: string | undefined } = process.env
) {
  const value = env["OXIDE_CELLD"];
  return value === "1" || value === "true";
};

/**
 * After a production build with `OXIDE_CELLD=1`, rewrite the Cloudflare Vite
 * `dist/ssr` snapshot into a celld-ready `dist/wrangler.json`.
 *
 * ```ts
 * oxide({ plugins: ["oxidejs/plugins/celld"] })
 * // package.json: "deploy:celld": "OXIDE_CELLD=1 vite build && celld deploy dist"
 * ```
 */
const celldPlugin: OxidePlugin = {
  afterBuild(ctx) {
    if (!isCelldPrepareEnabled()) {
      return;
    }
    const snapshot = path.join(ctx.outDir, "ssr", "wrangler.json");
    if (!fs.existsSync(snapshot)) {
      return;
    }
    prepareCelldDeploy(ctx.outDir);
  },
  name: "oxidejs/celld",
};

export default celldPlugin;
