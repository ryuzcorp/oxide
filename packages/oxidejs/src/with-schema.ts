import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { WITH_SCHEMA_PAYLOAD } from "./action";

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory
export class SchemaDecodeError extends Schema.TaggedError<SchemaDecodeError>()(
  "SchemaDecodeError",
  {
    message: Schema.String,
  }
) {
  static from(schemaError: Schema.SchemaError) {
    return new SchemaDecodeError({ message: schemaError.message });
  }
}

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
 * direct server calls. Decode failures are `Effect.fail(SchemaDecodeError)`. Over
 * RPC that becomes JSON-RPC invalid params (`-32602`). Schemas that need decoding
 * services are not supported — use `never` RD.
 */
export const withSchema = function withSchema<T, E, R>(
  schema: Schema.Codec<T, E, never, never>,
  handler: (payload: T) => R
): (payload: E) => R | Effect.Effect<never, SchemaDecodeError> {
  const wrapped = (payload: E) => {
    const decoded = Schema.decodeUnknownResult(schema)(payload);
    if (Result.isFailure(decoded)) {
      return Effect.fail(SchemaDecodeError.from(decoded.failure));
    }
    return handler(decoded.success);
  };
  // SAFETY: WITH_SCHEMA_PAYLOAD is oxide-owned; action() reads it for Rpc meta.
  (
    wrapped as typeof wrapped & {
      [WITH_SCHEMA_PAYLOAD]?: Schema.Codec<unknown, unknown, never, never>;
    }
  )[WITH_SCHEMA_PAYLOAD] = schema as Schema.Codec<
    unknown,
    unknown,
    never,
    never
  >;
  return wrapped;
};
