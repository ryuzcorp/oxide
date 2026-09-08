import * as Context from "effect/Context";

import type { ActionContext } from "./request-store";

/** Effect service for the full action context bag (same value as `useCtx()`). */
export class OxideCtx extends Context.Service<OxideCtx, ActionContext>()(
  "oxidejs/ActionCtx"
) {}
