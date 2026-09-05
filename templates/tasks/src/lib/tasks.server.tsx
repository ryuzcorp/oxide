import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { action } from "oxidejs";
import { createStorage } from "unstorage";

import type { Task } from "../server";

// SAFETY: process-global demo store; Bun may reuse the isolate across reloads.
const g = globalThis as typeof globalThis & {
  __tasks?: ReturnType<typeof createStorage<Task>>;
  __taskHub?: PubSub.PubSub<Task[]>;
  __taskMutate?: Promise<null>;
};

let tasks = g.__tasks;
if (!tasks) {
  tasks = createStorage<Task>();
  g.__tasks = tasks;
}

/** Sliding hub: slow consumers drop old snapshots; replay keeps the latest for late subscribers. */
let hub = g.__taskHub;
if (!hub) {
  hub = Effect.runSync(PubSub.sliding<Task[]>({ capacity: 16, replay: 1 }));
  g.__taskHub = hub;
}

const snapshot = async () => {
  const keys = await tasks.getKeys();
  const items = await Promise.all(keys.map((id) => tasks.getItem(id)));
  return items.filter(
    (task): task is Task => task !== null && task !== undefined
  );
};

/** Run a storage mutation and its snapshot publish as one critical section. */
const mutate = async (fn: () => Promise<null>) => {
  const prev = g.__taskMutate ?? Promise.resolve(null);
  const { promise, resolve } = Promise.withResolvers<null>();
  g.__taskMutate = promise;
  await prev;
  try {
    await fn();
    Effect.runSync(PubSub.publish(hub, await snapshot()));
  } finally {
    resolve(null);
  }
};

void mutate(() => Promise.resolve(null));

export const add = action(async (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  const id = crypto.randomUUID();
  await mutate(async () => {
    await tasks.setItem(id, { completed: false, id, text: trimmed });
    return null;
  });
});

export const toggle = action(async (id: string) => {
  await mutate(async () => {
    const task = await tasks.getItem(id);
    if (!task) {
      return null;
    }
    await tasks.setItem(id, { ...task, completed: !task.completed });
    return null;
  });
});

export const remove = action(async (id: string) => {
  await mutate(async () => {
    await tasks.removeItem(id);
    return null;
  });
});

export const list = action(async function* list() {
  yield* Stream.toAsyncIterable(Stream.fromPubSub(hub));
});

const toStreamError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

export const TaskCount = function TaskCount() {
  return Stream.map(
    Stream.fromAsyncIterable(list(), toStreamError),
    (items) => (
      <span class="badge badge-primary">
        {items.filter((task) => !task.completed).length}
      </span>
    )
  );
};

export const TaskList = function TaskList() {
  return Stream.map(
    Stream.fromAsyncIterable(list(), toStreamError),
    (items) => (
      <div class="flex flex-col gap-2">
        {items.length > 0 ? (
          items.map((todo) => (
            <div key={todo.id} class="flex items-center justify-between gap-2">
              <label class="label cursor-pointer justify-start gap-2">
                <input
                  type="checkbox"
                  class="checkbox"
                  checked={todo.completed}
                  onchange={toggle.bind(todo.id)}
                />
                <span>{todo.text}</span>
              </label>
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                onclick={remove.bind(todo.id)}
              >
                Delete
              </button>
            </div>
          ))
        ) : (
          <p>No todos.</p>
        )}
      </div>
    )
  );
};
