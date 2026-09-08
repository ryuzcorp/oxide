import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { OxideCtx } from "./oxide-ctx";
import type { ActionContext } from "./request-store";

/** Effect service for the inbound `Request` (same value as `useRequest()`). */
export class OxideRequest extends Context.Service<OxideRequest, Request>()(
  "oxidejs/Request"
) {}

export { OxideCtx } from "./oxide-ctx";

/** Layer that provides `OxideRequest` + `OxideCtx` from an ALS / sync store snapshot. */
export const actionContextLayer = function actionContextLayer(
  ctx: ActionContext
): Layer.Layer<OxideRequest | OxideCtx> {
  return Layer.merge(
    Layer.succeed(OxideRequest, ctx.req),
    Layer.succeed(OxideCtx, ctx)
  );
};
