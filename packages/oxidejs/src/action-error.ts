/* eslint-disable max-classes-per-file, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- RPC error envelopes and thrown values are untyped at the wire boundary */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

/**
 * Errors shared by the action server and the action client.
 *
 * A server action can only surface an error to the client by declaring an
 * `error` schema; anything else is scrubbed to `-32603 Internal error`. These
 * classes are the ones the client can identify, so `instanceof` keeps working
 * even when the bundler emits more than one copy of this module.
 */

/** JSON-RPC Invalid params — a payload failed its Effect Schema decode. */
const INVALID_PARAMS = -32_602;

/** Brand keys are `Symbol.for` so `instanceof` works across bundled copies. */
const ACTION_ERROR_BRAND = Symbol.for("oxidejs.ActionError");
const SCHEMA_DECODE_BRAND = Symbol.for("oxidejs.SchemaDecodeError");
const ACTION_FAILURE_BRAND = Symbol.for("oxidejs.ActionFailure");

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory
export class SchemaDecodeError extends Schema.TaggedError<SchemaDecodeError>()(
  "SchemaDecodeError",
  {
    message: Schema.String,
  }
) {
  static from(schemaError: Schema.SchemaError) {
    return Object.assign(
      new SchemaDecodeError({ message: schemaError.message }),
      { code: INVALID_PARAMS }
    );
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return (
      typeof value === "object" &&
      value !== null &&
      SCHEMA_DECODE_BRAND in value
    );
  }
}
Object.defineProperty(SchemaDecodeError.prototype, SCHEMA_DECODE_BRAND, {
  value: true,
});

/**
 * Thrown (or `Effect.fail`ed) by an action to surface a user-facing message.
 * An action that only uses `fail()` needs no `error` option — the generated RPC
 * group defaults its error schema to this class:
 *
 * ```ts
 * export const save = action(async () => {
 *   if (!allowed) fail("Not allowed");
 * });
 * ```
 *
 * Plain thrown `Error`s stay masked as `Internal error` — only a value matching
 * this schema reaches the client.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory
export class ActionFailure extends Schema.TaggedError<ActionFailure>()(
  "ActionFailure",
  {
    message: Schema.String,
  }
) {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return (
      typeof value === "object" &&
      value !== null &&
      ACTION_FAILURE_BRAND in value
    );
  }
}
Object.defineProperty(ActionFailure.prototype, ACTION_FAILURE_BRAND, {
  value: true,
});

/** Throw from an action to fail with a user-facing `message`. */
export const fail = function fail(message: string): never {
  throw new ActionFailure({ message });
};

/**
 * Client-side error for any answer that is not a successful action result.
 *
 * Carries the JSON-RPC `code`, the server error `_tag` (when the action
 * declared one) and the decoded error fields, so `String(error)` and
 * `error.message` / `error._tag` keep working.
 */
export class ActionError extends Error {
  readonly code: number | undefined;
  readonly _tag: string;

  static override [Symbol.hasInstance](value: unknown): boolean {
    return (
      typeof value === "object" && value !== null && ACTION_ERROR_BRAND in value
    );
  }

  constructor(input: {
    _tag?: string | undefined;
    code?: number | undefined;
    fields?: object | undefined;
    message: string;
  }) {
    super(input.message);
    // `fields` is wire data: copy own keys as plain properties. `Object.assign`
    // would invoke the `__proto__` setter for a JSON `"__proto__"` key.
    for (const [key, value] of Object.entries(input.fields ?? {})) {
      Object.defineProperty(this, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
    this.name = "ActionError";
    this._tag = input._tag ?? "ActionError";
    this.code = input.code;
    Object.defineProperty(this, ACTION_ERROR_BRAND, { value: true });
  }
}

/** The JSON-RPC error envelope scrub sends: `code` / `message`, plus `data`. */
interface RpcErrorEnvelope {
  code?: unknown;
  data?: unknown;
  message?: unknown;
}

/**
 * Rebuild a declared tagged error from the envelope's `data`.
 *
 * Only an `Error` subclass (a `Schema.TaggedError`) is rehydrated; a plain
 * struct error schema keeps the `ActionError` fallback so `_tag`/fields still
 * survive. The JSON-RPC `code` is stamped onto the instance.
 */
const decodeDeclaredError = function decodeDeclaredError(
  declared: Schema.Codec<unknown, unknown, never, never> | undefined,
  data: { [key: string]: unknown } | undefined,
  code: number | undefined
): Error | undefined {
  if (declared === undefined || data === undefined) {
    return undefined;
  }
  const decoded = Schema.decodeUnknownResult(declared)(data);
  if (Result.isFailure(decoded) || !(decoded.success instanceof Error)) {
    return undefined;
  }
  return Object.assign(decoded.success, { code });
};

/**
 * Normalize a raw RPC rejection into an `Error` instance.
 *
 * Transport/protocol errors (and anything already thrown as an `Error`) pass
 * through. Scrub sends a plain `{ code, message }` envelope, plus `data` for a
 * declared tagged error; this rebuilds the matching Oxide error class so
 * `instanceof Error` holds and `String(error)` is not `[object Object]`.
 *
 * Pass the action's declared `error` schema as `declared` to rehydrate the
 * class it names: `toActionError(envelope, NotFound)` rejects with a real
 * `NotFound` instance. Without it the envelope still becomes an `ActionError`
 * carrying `_tag` and the decoded fields.
 */
export const toActionError = function toActionError(
  error: unknown,
  declared?: Schema.Codec<unknown, unknown, never, never>
): Error {
  if (error instanceof Error) {
    return error;
  }
  if (error === null || typeof error !== "object" || Array.isArray(error)) {
    return new ActionError({ message: String(error) });
  }
  // SAFETY: the RPC client rejects with scrub's JSON error envelope; every
  // field is validated below before use.
  const {
    code: rawCode,
    data: rawData,
    message: rawMessage,
  } = error as RpcErrorEnvelope;
  const code = typeof rawCode === "number" ? rawCode : undefined;
  // SAFETY: scrub nests the encoded tagged error object under `data`, if any.
  const data =
    typeof rawData === "object" && rawData !== null && !Array.isArray(rawData)
      ? (rawData as { [key: string]: unknown })
      : undefined;
  const { _tag: rawTag, message: rawDataMessage } = data ?? {};
  const tag = typeof rawTag === "string" ? rawTag : undefined;
  let message: string;
  if (typeof rawMessage === "string") {
    message = rawMessage;
  } else if (typeof rawDataMessage === "string") {
    message = rawDataMessage;
  } else {
    message = tag ?? String(error);
  }

  if (tag === "SchemaDecodeError" || code === INVALID_PARAMS) {
    return Object.assign(new SchemaDecodeError({ message }), { code });
  }
  if (tag === "ActionFailure") {
    return Object.assign(new ActionFailure({ message }), { code });
  }
  const declaredError = decodeDeclaredError(declared, data, code);
  if (declaredError !== undefined) {
    return declaredError;
  }
  return new ActionError({ _tag: tag, code, fields: data, message });
};

/**
 * Client-side `error` codec for one generated action Rpc.
 *
 * The server encodes a declared tagged error and Effect's JSON-RPC layer wraps
 * it in `{ code, message, data }`; the client decodes that envelope, not the
 * bare encoded error, so the declared schema cannot be used on its own. This
 * codec unwraps the envelope and, when `declared` is given, rebuilds the class
 * it names (`instanceof` holds, fields are real, `code` is kept). `ActionFailure`
 * and `SchemaDecodeError` stay shared fallbacks. Decoding never fails: an
 * unexpected shape still rejects with an `ActionError`.
 */
export const clientErrorSchema = function clientErrorSchema(
  declared?: Schema.Codec<unknown, unknown, never, never>
) {
  return Schema.Unknown.pipe(
    Schema.decodeTo(Schema.Unknown, {
      decode: SchemaGetter.transform((envelope: unknown) =>
        toActionError(envelope, declared)
      ),
      encode: SchemaGetter.passthrough<unknown>(),
    })
  );
};
