import { action } from "@ilha/router/server";
import { Badge, Button, Checkbox } from "areia";
import { derived, each, ilha } from "ilha";
import { useRequest } from "oxidejs";
import { Publisher } from "tacho";
import { createStorage } from "unstorage";
import type { Task } from "../server";

const g = globalThis as typeof globalThis & {
  __tasks?: ReturnType<typeof createStorage<Task>>;
  __taskEvents?: Publisher<{ change: Task[] }>;
};
// ponytail: in-memory unstorage; KV/DO driver when celld has a binding we can deploy
const tasks = (g.__tasks ??= createStorage<Task>());
const events = (g.__taskEvents ??= new Publisher());

const snapshot = async () => {
  const out: Task[] = [];
  for (const id of await tasks.getKeys()) {
    const task = await tasks.getItem(id);
    if (task) out.push(task);
  }
  return out;
};

export const add = action(async (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return;
  const id = crypto.randomUUID();
  await tasks.setItem(id, { id, text: trimmed, completed: false });
  events.publish("change", await snapshot());
});

export const toggle = action(async (id: string) => {
  const task = await tasks.getItem(id);
  if (!task) return;
  await tasks.setItem(id, { ...task, completed: !task.completed });
  events.publish("change", await snapshot());
});

export const remove = action(async (id: string) => {
  await tasks.removeItem(id);
  events.publish("change", await snapshot());
});

export const list = action(async function* () {
  const signal = useRequest().signal;
  try {
    yield await snapshot();
    for await (const next of events.subscribe("change", { signal })) yield next;
  } catch (error) {
    if ((error as { name?: string }).name !== "AbortError") throw error;
  }
});

export const TaskCount = ilha(() => {
  const items = derived(async function* () {
    yield* list();
  });
  const count = derived(() => items()?.filter((task) => !task.completed).length ?? 0);
  return <Badge>{count()}</Badge>;
});

export const TaskList = ilha(() => {
  const items = derived(async function* () {
    yield* list();
  });
  return (
    <div class="flex flex-col gap-2">
      {each(items() ?? [])
        .as((todo) => (
          <div data-key={todo.id} class="flex items-center justify-between gap-2">
            <Checkbox
              checked={todo.completed}
              label={todo.text}
              onCheckedChange={toggle.with(todo.id)}
            />
            <Button type="button" onclick={remove.with(todo.id)}>
              Delete
            </Button>
          </div>
        ))
        .else(<p>No todos.</p>)}
    </div>
  );
});
