import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { action } from "oxidejs";
import { createStorage } from "unstorage";
import type { Task } from "../server";

const g = globalThis as typeof globalThis & {
  __tasks?: ReturnType<typeof createStorage<Task>>;
  __taskHub?: PubSub.PubSub<Task[]>;
  __taskMutate?: Promise<void>;
};

const tasks = (g.__tasks ??= createStorage<Task>());
/** Sliding hub: slow consumers drop old snapshots; replay keeps the latest for late subscribers. */
const hub = (g.__taskHub ??= Effect.runSync(PubSub.sliding<Task[]>({ capacity: 16, replay: 1 })));

const snapshot = async () => {
  const items = await Promise.all((await tasks.getKeys()).map((id) => tasks.getItem(id)));
  return items.filter((task) => task != null);
};

/** Run a storage mutation and its snapshot publish as one critical section. */
const mutate = async (fn: () => Promise<void>) => {
  const prev = g.__taskMutate ?? Promise.resolve();
  let release!: () => void;
  g.__taskMutate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    await fn();
    Effect.runSync(PubSub.publish(hub, await snapshot()));
  } finally {
    release();
  }
};

void mutate(async () => {});

export const add = action(async (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return;
  const id = crypto.randomUUID();
  await mutate(async () => {
    await tasks.setItem(id, { id, text: trimmed, completed: false });
  });
});

export const toggle = action(async (id: string) => {
  await mutate(async () => {
    const task = await tasks.getItem(id);
    if (!task) return;
    await tasks.setItem(id, { ...task, completed: !task.completed });
  });
});

export const remove = action(async (id: string) => {
  await mutate(async () => {
    await tasks.removeItem(id);
  });
});

export const list = action(async function* () {
  yield* Stream.toAsyncIterable(Stream.fromPubSub(hub));
});

const streamError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

export const TaskCount = async function TaskCount() {
  return Stream.map(Stream.fromAsyncIterable(list(), streamError), (items) => (
    <span class="badge badge-primary">{items.filter((task) => !task.completed).length}</span>
  ));
};

export const TaskList = async function TaskList() {
  return Stream.map(Stream.fromAsyncIterable(list(), streamError), (items) => (
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
            <button type="button" class="btn btn-sm btn-ghost" onclick={remove.bind(todo.id)}>
              Delete
            </button>
          </div>
        ))
      ) : (
        <p>No todos.</p>
      )}
    </div>
  ));
};
