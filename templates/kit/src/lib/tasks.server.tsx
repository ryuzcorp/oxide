import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { action, liveQuery, useIdempotencyKey, withSchema } from "oxidejs";
import { once } from "paranorm";

import { orm, runDb, useDb } from "./db";
import type { Task } from "./db";

const tasks = liveQuery<Task[]>({ topic: "tasks" });

const AddTask = Schema.Struct({
  text: Schema.String,
});

const asTask = (row: Task): Task => ({
  ...row,
  completed: Boolean(row.completed),
});

const snapshot = async (db: D1Database) => {
  const rows = await runDb(
    orm.tasks.findMany({
      orderBy: [{ id: "asc" }],
    }),
    db
  );
  return rows.map(asTask);
};

/** Run `fn` once when the client sent an idempotency key (mutation-queue replay). */
const runWrite = <A, E>(
  db: D1Database,
  fn: () => Effect.Effect<A, E, SqlClient>
) => {
  const key = useIdempotencyKey();
  if (!key) {
    return runDb(fn(), db);
  }
  return runDb(once(key, fn), db);
};

export const add = action(
  withSchema(AddTask, async ({ text }) => {
    const db = useDb();
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    await tasks.mutate(async () => {
      await runWrite(db, () =>
        orm.tasks.create({
          data: {
            completed: false,
            id: crypto.randomUUID(),
            text: trimmed,
          },
        })
      );
      return snapshot(db);
    });
  })
);

export const toggle = action(async (id: string) => {
  const db = useDb();
  await tasks.mutate(async () => {
    await runWrite(db, () =>
      Effect.gen(function* toggleTask() {
        const task = yield* orm.tasks.findFirst({ where: { id } });
        if (!task) {
          return;
        }
        yield* orm.tasks.update({
          data: { completed: !asTask(task).completed },
          where: { id },
        });
      })
    );
    return snapshot(db);
  });
});

export const remove = action(async (id: string) => {
  const db = useDb();
  await tasks.mutate(async () => {
    await runWrite(db, () =>
      Effect.gen(function* removeTask() {
        const task = yield* orm.tasks.findFirst({ where: { id } });
        if (!task) {
          return;
        }
        yield* orm.tasks.delete({ where: { id } });
      })
    );
    return snapshot(db);
  });
});

/** Live snapshots. Capture `useDb()` before any await (Worker sync-store path). */
export const list = action(
  tasks.subscribe(async () => {
    const db = useDb();
    await tasks.mutate(() => snapshot(db));
  })
);
