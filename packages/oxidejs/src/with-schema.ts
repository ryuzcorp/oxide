import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { WITH_SCHEMA_PAYLOAD } from "./action";

export class SchemaDecodeError extends Error {
  override name = "SchemaDecodeError";
  readonly schemaError: Schema.SchemaError;

  constructor(schemaError: Schema.SchemaError) {
    super(schemaError.message);
    this.schemaError = schemaError;
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
 * direct server calls. Decode failures reject with `SchemaDecodeError`. Over RPC
 * that becomes JSON-RPC invalid params (`-32602`). Schemas that need decoding
 * services are not supported — use `never` RD.
 */
export const withSchema = function withSchema<T, E, R>(
  schema: Schema.Codec<T, E, never, never>,
  handler: (payload: T) => R | Promise<R>
): (payload: E) => Promise<Awaited<R>> {
  const wrapped = (payload: E) => {
    const decoded = Schema.decodeUnknownResult(schema)(payload);
    if (Result.isFailure(decoded)) {
      return Promise.reject(new SchemaDecodeError(decoded.failure));
    }
    return Promise.resolve(handler(decoded.success));
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
