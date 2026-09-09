import { stampRequestContext } from "oxidejs";
import type { ActionContextValue } from "oxidejs";

/**
 * Stamp `env.DB` onto the request context as `db` for `useCtx()` / `useDb()`.
 * Runs before actions and WebSocket upgrade.
 */
export default function db(
  request: Request,
  context: { env?: KitEnv; ctx?: unknown }
) {
  const binding = context.env?.DB;
  if (binding) {
    // SAFETY: D1Database is a request-scoped host binding; useDb() narrows it back.
    stampRequestContext(request, { db: binding as ActionContextValue });
  }
}
