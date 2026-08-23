import ilha from "ilha";
import { action, useRequest } from "oxidejs";
import { Publisher } from "tacho";
import { createStorage } from "unstorage";

export type Task = { id: string; text: string };

const g = globalThis as typeof globalThis & {
  __tasks?: {
    storage: ReturnType<typeof createStorage<string>>;
    events: Publisher<{ change: Task[] }>;
    watching?: Promise<unknown>;
  };
};
const state = (g.__tasks ??= {
  storage: createStorage<string>(),
  events: new Publisher(),
});

const snapshot = async () => {
  const tasks: Task[] = [];
  for (const id of await state.storage.getKeys()) {
    const text = await state.storage.getItem(id);
    if (text) tasks.push({ id, text });
  }
  return tasks;
};

// Bridge storage changes into the publisher once per process.
async function startWatch() {
  state.watching ??= state.storage.watch(async (event, id) => {
    if (event === "remove") {
      state.events.publish("change", await snapshot());
      return;
    }
    const text = await state.storage.getItem(id);
    if (text) state.events.publish("change", await snapshot());
  });
  await state.watching;
}

export const add = action(async (text: string) => {
  const id = crypto.randomUUID();
  await state.storage.setItem(id, text);
});

export const remove = action(async (id: string) => {
  await state.storage.removeItem(id);
});

export const list = action(async function* () {
  const signal = useRequest().signal;
  await startWatch();
  yield await snapshot();
  for await (const tasks of state.events.subscribe("change", { signal })) yield tasks;
});

// Server-owned island: streams live task state and exposes mutations as
// actions. The render function never ships to the browser.
export const TaskList = ilha
  .stream("tasks", () => list())
  .action("remove", (id: string) => remove(id))
  .render(({ state, action }) => (
    <ul>
      {(state.tasks() ?? []).map((task) => (
        <li key={task.id}>
          {task.text}
          <button type="button" onclick={() => action.remove(task.id)}>
            Remove
          </button>
        </li>
      ))}
    </ul>
  ));
