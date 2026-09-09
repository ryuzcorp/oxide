import type * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

export interface OxideRuntimeOptions {
  /**
   * Pretty console logger. Default `true`.
   * Set `false` for the plain default logger.
   */
  pretty?: boolean;
}

/**
 * Host Layer for Effect log/span collection around app Effects.
 * Action handlers already stamp `oxidejs.action` spans — provide this (or your
 * own Logger / Tracer Layer) at the Worker / Node entry if you want them
 * collected.
 *
 * ```ts
 * import { Effect } from "effect";
 * import { oxideRuntimeLayer } from "oxidejs";
 *
 * await Effect.runPromise(
 *   myEffect.pipe(Effect.provide(oxideRuntimeLayer()))
 * );
 * ```
 */
export const oxideRuntimeLayer = function oxideRuntimeLayer(
  options?: OxideRuntimeOptions
): Layer.Layer<never> {
  const pretty = options?.pretty ?? true;
  return Logger.layer([pretty ? Logger.consolePretty() : Logger.defaultLogger]);
};
