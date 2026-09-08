import { D1Client } from "@effect/sql-d1";
import * as Effect from "effect/Effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { useCtx, useEnv } from "oxidejs";
import { createMigrator, defineSchema, paranorm } from "paranorm";
import type { InferSchema, Selectable } from "paranorm";

export const schemaV1 = defineSchema(`
  _version: "1.0.0"
  tasks:
    id: id(uuidv4)
    text: string
    completed: boolean default=false
`);

export const schema = defineSchema(`
  _version: "1.1.0"
  _extends: [idempotency]
  tasks:
    id: id(uuidv4)
    text: string
    completed: boolean default=false
`);

export type DB = InferSchema<typeof schema>;
export type Task = Selectable<DB["tasks"]>;

export const orm = paranorm<DB>();

const migrator = createMigrator([schemaV1, schema]);

export class MissingD1Error extends Error {
  override name = "MissingD1Error";

  constructor() {
    super(
      "kit: D1 binding env.DB is missing. Build the app and run it with celld (celld dev dist)."
    );
  }
}

const migrations = new WeakMap<D1Database, Promise<null>>();

const d1Layer = (db: D1Database) => D1Client.layer({ db });

const ensureMigrated = (db: D1Database) => {
  let pending = migrations.get(db);
  if (!pending) {
    pending = (async () => {
      await Effect.runPromise(
        migrator.migrate.pipe(Effect.provide(d1Layer(db)), Effect.scoped)
      );
      return null;
    })();
    migrations.set(db, pending);
  }
  return pending;
};

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
    throw new MissingD1Error();
  }
  return env.DB;
};

/** @deprecated Prefer `useDb()`. */
export const requireDb = useDb;

export const runDb = async <A, E>(
  effect: Effect.Effect<A, E, SqlClient>,
  db: D1Database = useDb()
) => {
  await ensureMigrated(db);
  return Effect.runPromise(
    effect.pipe(Effect.provide(d1Layer(db)), Effect.scoped)
  );
};
