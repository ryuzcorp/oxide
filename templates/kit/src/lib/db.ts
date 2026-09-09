import { D1Client } from "@effect/sql-d1";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { useCtx, useEnv } from "oxidejs";
import { createMigrator, defineSchema, paranorm } from "paranorm";
import type { InferSchema, Selectable } from "paranorm";

/** Auth + app tables in one schema — https://github.com/ryuzcorp/paranorm/blob/main/DOCS.md */
const schema = defineSchema(`
  _version: "1.0.0"
  _extends: [idempotency]

  user:
    id: id
    name: string
    email: string unique
    emailVerified: boolean default=false
    image: string?
    role: string default="user"
    banned: boolean default=false
    banReason: string?
    banExpires: timestamp?
    createdAt: timestamp default=now
    updatedAt: timestamp default=now
    _relations:
      accounts: has_many=account
      sessions: has_many=session

  session:
    id: id
    expiresAt: timestamp
    token: string unique
    createdAt: timestamp default=now
    updatedAt: timestamp default=now
    ipAddress: string?
    userAgent: string?
    userId: references=user.id on_delete=cascade index
    impersonatedBy: string?
    _relations:
      user: belongs_to=user

  account:
    id: id
    accountId: string
    providerId: string
    userId: references=user.id on_delete=cascade index
    accessToken: string?
    refreshToken: string?
    idToken: string?
    accessTokenExpiresAt: timestamp?
    refreshTokenExpiresAt: timestamp?
    scope: string?
    password: string?
    createdAt: timestamp default=now
    updatedAt: timestamp default=now
    _relations:
      user: belongs_to=user

  verification:
    id: id
    identifier: string index
    value: string
    expiresAt: timestamp
    createdAt: timestamp default=now
    updatedAt: timestamp default=now

  passkey:
    id: id
    name: string?
    publicKey: string
    userId: references=user.id on_delete=cascade index
    credentialID: string index
    counter: int
    deviceType: string
    backedUp: boolean
    transports: string?
    createdAt: timestamp? default=now
    aaguid: string?
    _relations:
      user: belongs_to=user

  tasks:
    id: id(uuidv4)
    userId: references=user.id on_delete=cascade index
    text: string
    completed: boolean default=false
    _relations:
      user: belongs_to=user
`);

export type DB = InferSchema<typeof schema>;
export type Task = Selectable<DB["tasks"]>;

export const orm = paranorm<DB>();

const migrator = createMigrator([schema]);

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory
export class MissingD1Error extends Schema.TaggedError<MissingD1Error>()(
  "MissingD1Error",
  {
    message: Schema.String,
  }
) {}

export const missingD1 = () =>
  new MissingD1Error({
    message:
      "kit: D1 binding env.DB is missing. Build the app and run it with celld (celld dev dist).",
  });

const migrations = new WeakMap<D1Database, Promise<null>>();

/** Effect Layer for this D1 binding (`SqlClient`). */
const dbLayer = (db: D1Database) => D1Client.layer({ db });

/** Apply pending ParanORM migrations for this D1 binding (once per isolate). */
export const ensureDb = (db: D1Database) => {
  let pending = migrations.get(db);
  if (!pending) {
    pending = (async () => {
      await Effect.runPromise(
        migrator.migrate.pipe(Effect.provide(dbLayer(db)), Effect.scoped)
      );
      return null;
    })();
    migrations.set(db, pending);
  }
  return pending;
};

export const ensureDbEffect = (db: D1Database) =>
  Effect.promise(() => ensureDb(db));

/**
 * D1 binding for this request. Prefers `useCtx().db` (middleware stamp),
 * then `useEnv().DB`. Capture before the first await on Workers.
 */
export const useDb = () => {
  // SAFETY: middleware stamps D1Database as ctx.db; ActionContext index is JSON-ish.
  const ctx = useCtx() as ReturnType<typeof useCtx> & { db?: D1Database };
  if (ctx.db) {
    return ctx.db;
  }
  const env = useEnv<{ DB?: D1Database }>();
  if (!env?.DB) {
    throw missingD1();
  }
  return env.DB;
};

/**
 * Run an Effect that needs `SqlClient` against this request's D1 binding.
 * Prefer this from action handlers over Promise wrappers.
 */
export const withDb = <A, E, R>(
  effect: Effect.Effect<A, E, R | SqlClient>,
  db: D1Database = useDb()
): Effect.Effect<A, E, Exclude<R, SqlClient>> =>
  // SAFETY: D1Client.layer provides SqlClient; scoped + runPromise drop Scope.
  ensureDbEffect(db).pipe(
    Effect.andThen(() => effect),
    Effect.provide(dbLayer(db)),
    Effect.scoped
  ) as Effect.Effect<A, E, Exclude<R, SqlClient>>;
