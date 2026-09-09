/* eslint-disable max-classes-per-file -- tagged Fail types for auth */
/* eslint-disable func-names -- Effect.gen uses anonymous generators (AGENTS.md) */
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { admin } from "better-auth/plugins";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { OxideCtx, OxideRequest } from "oxidejs";

import { ensureDbEffect, missingD1 } from "./db";

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory
export class MissingAuthSecretError extends Schema.TaggedError<MissingAuthSecretError>()(
  "MissingAuthSecretError",
  { message: Schema.String }
) {}

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory
export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()(
  "UnauthorizedError",
  { message: Schema.String }
) {}

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory
class InvalidRegistrationContextError extends Schema.TaggedError<InvalidRegistrationContextError>()(
  "InvalidRegistrationContextError",
  { message: Schema.String }
) {}

const RegistrationContext = Schema.Struct({
  email: Schema.String,
  name: Schema.String,
});

const parseRegistration = (context: string | null | undefined) =>
  Effect.gen(function* () {
    if (!context) {
      return yield* Effect.fail(
        new InvalidRegistrationContextError({
          message: "Registration context is required",
        })
      );
    }
    const raw = yield* Effect.try({
      catch: () =>
        new InvalidRegistrationContextError({
          message: "Registration context must be JSON",
        }),
      try: () => JSON.parse(context),
    });
    const decoded = yield* Schema.decodeUnknownEffect(RegistrationContext)(
      raw
    ).pipe(
      Effect.mapError(
        () =>
          new InvalidRegistrationContextError({
            message: "Registration context needs email and name strings",
          })
      )
    );
    const email = decoded.email.trim().toLowerCase();
    const name = decoded.name.trim();
    if (!(email && name)) {
      return yield* Effect.fail(
        new InvalidRegistrationContextError({
          message: "Email and name must be non-empty",
        })
      );
    }
    return { email, name };
  });

const requireRegistration = (context: string | null | undefined) => {
  try {
    return Effect.runSync(parseRegistration(context));
  } catch (error) {
    if (error instanceof InvalidRegistrationContextError) {
      throw APIError.from("BAD_REQUEST", {
        code: "INVALID_REGISTRATION_CONTEXT",
        message: error.message,
      });
    }
    throw error;
  }
};

/** Better Auth for this D1 request. Create once per fetch that hits `/api/auth`. */
export const createAuth = (
  db: D1Database,
  env: { BETTER_AUTH_SECRET: string; BETTER_AUTH_URL?: string },
  baseURL: string
) =>
  betterAuth({
    // ParanORM owns migrations. Better Auth's schema check uses
    // `pragma_table_info(?)`, which D1/celld rejects (SQLITE_AUTH).
    advanced: {
      database: {
        validateSchema: false,
      },
    },
    baseURL,
    database: db,
    plugins: [
      admin({ defaultRole: "user" }),
      passkey({
        registration: {
          afterVerification: async ({ context, ctx }) => {
            const parsed = requireRegistration(context);
            const existing = await ctx.context.internalAdapter.findUserByEmail(
              parsed.email
            );
            if (existing?.user) {
              throw APIError.from("BAD_REQUEST", {
                code: "USER_ALREADY_EXISTS",
                message:
                  "An account with this email already exists. Sign in instead.",
              });
            }
            const user = await ctx.context.internalAdapter.createUser(
              {
                email: parsed.email,
                emailVerified: true,
                name: parsed.name,
              },
              { method: "passkey" }
            );
            return { userId: user.id };
          },
          requireSession: false,
          resolveUser: ({ context }) => {
            const parsed = requireRegistration(context);
            return {
              displayName: parsed.name,
              id: crypto.randomUUID(),
              name: parsed.email,
            };
          },
        },
        rpID: new URL(baseURL).hostname,
        rpName: "Kit",
      }),
    ],
    secret: env.BETTER_AUTH_SECRET,
  });

/** Bind Better Auth from Worker env. Throws `MissingAuthSecretError` when unset. */
export const authFromEnv = (db: D1Database, env: KitEnv, origin: string) => {
  if (!env.BETTER_AUTH_SECRET) {
    throw new MissingAuthSecretError({
      message: "kit: BETTER_AUTH_SECRET is missing",
    });
  }
  return createAuth(
    db,
    {
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    },
    env.BETTER_AUTH_URL ?? origin
  );
};

export interface SessionUser {
  email: string;
  id: string;
  name: string;
}

/** Session user for this action/request. Fails with `UnauthorizedError` when signed out. */
export const requireUser = Effect.gen(function* () {
  const request = yield* OxideRequest;
  const ctx = yield* OxideCtx;
  // Prefer Effect services over ALS so Stream.unwrap pulls still see bindings.
  // SAFETY: middleware stamps D1Database as ctx.db.
  const stampedDb = ctx.db as D1Database | undefined;
  // SAFETY: Worker env bag may include the D1 binding.
  const env = (ctx.env as KitEnv | undefined) ?? {};
  const db = stampedDb ?? env.DB;
  if (!db) {
    throw missingD1();
  }
  yield* ensureDbEffect(db);
  const auth = authFromEnv(db, env, new URL(request.url).origin);
  const session = yield* Effect.tryPromise({
    catch: () => new UnauthorizedError({ message: "Sign in required" }),
    try: () => auth.api.getSession({ headers: request.headers }),
  });
  const user = session?.user;
  if (!user) {
    return yield* Effect.fail(
      new UnauthorizedError({ message: "Sign in required" })
    );
  }
  return { email: user.email, id: user.id, name: user.name };
});
