/* eslint-disable func-names -- Effect.gen uses anonymous generators (AGENTS.md) */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { action, liveQuery, useEnv, useRequest, withSchema } from "oxidejs";

import { authFromEnv, MissingAuthSecretError, UnauthorizedError } from "./auth";
import type { SessionUser } from "./auth";
import { ensureDb, orm, useDb, withDb } from "./db";
import type { Task } from "./db";

const AddTask = Schema.Struct({ text: Schema.String });
const TaskId = Schema.String;
const AuthError = Schema.Union([UnauthorizedError, MissingAuthSecretError]);

const asTask = (row: Task): Task => ({
  ...row,
  completed: Boolean(row.completed),
});

const tasksFor = (userId: string) =>
  liveQuery<Task[]>({ topic: `tasks:${userId}` });

const snapshot = (userId: string) =>
  orm.tasks
    .findMany({ orderBy: [{ id: "asc" }], where: { userId } })
    .pipe(Effect.map((rows) => rows.map(asTask)));

/** Capture bindings before any await (Worker sync-store path). */
const sessionUser = async (db: D1Database): Promise<SessionUser> => {
  const request = useRequest();
  const env = useEnv<KitEnv>() ?? {};
  await ensureDb(db);
  const auth = authFromEnv(db, env, new URL(request.url).origin);
  const session = await auth.api.getSession({ headers: request.headers });
  const user = session?.user;
  if (!user) {
    throw new UnauthorizedError({ message: "Sign in required" });
  }
  return { email: user.email, id: user.id, name: user.name };
};

/**
 * Write + republish snapshot on the per-user hub.
 * Skip paranorm `once()` on D1 — `SELECT changes()` is always 0 across statements.
 */
const mutateForUser = async (
  write: (user: SessionUser) => Effect.Effect<unknown, unknown, SqlClient>
) => {
  const db = useDb();
  const user = await sessionUser(db);
  const tasks = tasksFor(user.id);
  await tasks.mutate(() =>
    Effect.runPromise(
      withDb(
        Effect.gen(function* () {
          yield* write(user);
          return yield* snapshot(user.id);
        }),
        db
      )
    )
  );
};

export const add = action(
  withSchema(AddTask, async ({ text }) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    await mutateForUser((user) =>
      orm.tasks.create({
        data: {
          completed: false,
          id: crypto.randomUUID(),
          text: trimmed,
          userId: user.id,
        },
      })
    );
  }),
  { error: AuthError }
);

export const toggle = action(
  withSchema(TaskId, async (id) => {
    await mutateForUser((user) =>
      Effect.gen(function* () {
        const task = yield* orm.tasks.findFirst({
          where: { id, userId: user.id },
        });
        if (!task) {
          return;
        }
        yield* orm.tasks.update({
          data: { completed: !asTask(task).completed },
          where: { id, userId: user.id },
        });
      })
    );
  }),
  { error: AuthError }
);

export const remove = action(
  withSchema(TaskId, async (id) => {
    await mutateForUser((user) =>
      Effect.gen(function* () {
        const task = yield* orm.tasks.findFirst({
          where: { id, userId: user.id },
        });
        if (!task) {
          return;
        }
        yield* orm.tasks.delete({ where: { id, userId: user.id } });
      })
    );
  }),
  { error: AuthError }
);

/** Live snapshots. Capture `useDb()` before any await (Worker sync-store path). */
export const list = action(
  async function* () {
    const db = useDb();
    const user = await sessionUser(db);
    const tasks = tasksFor(user.id);
    yield* tasks.subscribe(async () => {
      await tasks.mutate(() =>
        Effect.runPromise(withDb(snapshot(user.id), db))
      );
    })();
  },
  { error: AuthError }
);
