import ilha from "ilha";
import { action, useEnv, useRequest } from "oxidejs";
import { Publisher } from "tacho";
import type { Env } from "./env";
import type { Task } from "./server";

function getDO() {
  const env = useEnv<Env>();
  if (!env?.TASKS) throw new Error("Missing TASKS binding");
  const id = env.TASKS.idFromName("global");
  return env.TASKS.get(id);
}

// In-memory event bridge so add/remove notify open SSE streams.
const g = globalThis as typeof globalThis & {
  __taskEvents?: Publisher<{ change: Task[] }>;
};
const events = (g.__taskEvents ??= new Publisher());

export const add = action(async (text: string) => {
  const task = await getDO().addTask(text);
  events.publish("change", await getDO().getTasks());
  return task;
});

export const remove = action(async (id: string) => {
  await getDO().removeTask(id);
  events.publish("change", await getDO().getTasks());
});

export const list = action(async function* () {
  const signal = useRequest().signal;
  yield await getDO().getTasks();
  for await (const tasks of events.subscribe("change", { signal })) yield tasks;
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
