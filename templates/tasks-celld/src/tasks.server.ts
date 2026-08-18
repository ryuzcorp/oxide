import { useEnv, useRequest } from "oxidejs";
import type { Env } from "./env";
import type { Task } from "./server";

export type TaskEvent =
  | { type: "snapshot"; tasks: Task[] }
  | { type: "set"; task: Task }
  | { type: "remove"; id: string };

function getDO() {
  const env = useEnv<Env>();
  if (!env?.TASKS) throw new Error("Missing TASKS binding");
  const id = env.TASKS.idFromName("global");
  return env.TASKS.get(id);
}

// In-memory event bridge so add/remove notify open SSE streams
const g = globalThis as typeof globalThis & {
  __taskListeners?: Set<(event: TaskEvent) => void>;
};
const listeners = (g.__taskListeners ??= new Set());

function emit(event: TaskEvent) {
  for (const fn of listeners) fn(event);
}

export async function add(text: string) {
  const task = await getDO().addTask(text);
  emit({ type: "set", task });
  return task;
}

export async function remove(id: string) {
  await getDO().removeTask(id);
  emit({ type: "remove", id });
}

export async function* list() {
  const signal = useRequest().signal;
  const tasks = await getDO().getTasks();
  yield { type: "snapshot", tasks } satisfies TaskEvent;
  if (signal.aborted) return;

  const queue: TaskEvent[] = [];
  let wake: (() => void) | undefined;

  const onEvent = (event: TaskEvent) => {
    queue.push(event);
    wake?.();
  };
  listeners.add(onEvent);

  const onAbort = () => wake?.();
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (!signal.aborted) {
      if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
      const next = queue.shift();
      if (next) yield next;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    listeners.delete(onEvent);
  }
}
