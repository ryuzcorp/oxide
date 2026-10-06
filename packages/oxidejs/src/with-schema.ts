import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { ActionHandler } from "./action";
import { WITH_SCHEMA_HANDLER, WITH_SCHEMA_PAYLOAD } from "./action";
import { SchemaDecodeError } from "./action-error";

/**
 * Decode the action's single payload with Effect Schema before the handler runs.
 * Use inside `action()` so Oxide still recognizes the export:
 *
 * ```ts
 * export const add = action(
 *   withSchema(Schema.Struct({ text: Schema.String }), async (payload) => {
 *     // payload.text is string
 *   })
 * )
 * ```
 *
 * Equivalent to `action(handler, { payload: schema })` plus a local decode for
 * direct server calls. A direct call with an invalid payload throws
 * {@link SchemaDecodeError} synchronously, before the handler runs; through
 * `action()` that is a rejected promise. Over RPC the generated payload schema
 * rejects for you, so an invalid payload is JSON-RPC invalid params (`-32602`).
 *
 * The declared return is the handler's own result type (no data-or-Effect
 * union), so `await add(payload)` is typed as data. Schemas that need decoding
 * services are not supported — use `never` RD.
 */
export const withSchema = function withSchema<T, E, R>(
  schema: Schema.Codec<T, E, never, never>,
  handler: (payload: T) => R
): (payload: E) => R {
  const wrapped = (payload: E) => {
    const decoded = Schema.decodeUnknownResult(schema)(payload);
    if (Result.isFailure(decoded)) {
      // Throw, not a rejected promise typed as `R`: the declared return stays
      // honest for sync handlers, and `action()` turns the throw into a
      // rejection.
      throw SchemaDecodeError.from(decoded.failure);
    }
    return handler(decoded.success);
  };
  // SAFETY: WITH_SCHEMA_PAYLOAD / WITH_SCHEMA_HANDLER are oxide-owned; action()
  // reads them for Rpc meta. The handler receives the already-decoded payload
  // on the RPC path, so it is stored without the wrapper's local decode.
  const carrier = wrapped as typeof wrapped & {
    [WITH_SCHEMA_PAYLOAD]?: Schema.Codec<unknown, unknown, never, never>;
    [WITH_SCHEMA_HANDLER]?: ActionHandler;
  };
  // SAFETY: `schema` is the codec this wrapper decodes with, widened to the
  // oxide-owned meta slot.
  carrier[WITH_SCHEMA_PAYLOAD] = schema as Schema.Codec<
    unknown,
    unknown,
    never,
    never
  >;
  // SAFETY: `handler` takes the decoded `T`; the meta slot is an opaque callable.
  carrier[WITH_SCHEMA_HANDLER] = handler as ActionHandler;
  return wrapped;
};
