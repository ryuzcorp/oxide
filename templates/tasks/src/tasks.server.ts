import { action, useRequest } from "oxidejs";
import { createStorage } from "unstorage";

export type Task = { id: string; text: string };
export type TaskEvent =
  | { type: "snapshot"; tasks: Task[] }
  | { type: "set"; task: Task }
  | { type: "remove"; id: string };

const g = globalThis as typeof globalThis & {
  __ilhaTasks?: ReturnType<typeof createStorage<string>>;
};
const storage = (g.__ilhaTasks ??= createStorage<string>());

export const add = action(async (text: string) => {
  const id = crypto.randomUUID();
  await storage.setItem(id, text);
  return { id, text };
});

export const remove = action(async (id: string) => {
  await storage.removeItem(id);
});

export const list = action(async function* () {
  const signal = useRequest().signal;
  const snapshot: Task[] = [];
  for (const id of await storage.getKeys()) {
    const text = await storage.getItem(id);
    if (text) snapshot.push({ id, text });
  }
  yield { type: "snapshot", tasks: snapshot } satisfies TaskEvent;
  if (signal.aborted) return;

  const queue: TaskEvent[] = [];
  let wake: (() => void) | undefined;
  const unwatch = await storage.watch(async (event, id) => {
    if (event === "remove") queue.push({ type: "remove", id });
    else {
      const text = await storage.getItem(id);
      if (text) queue.push({ type: "set", task: { id, text } });
    }
    wake?.();
  });
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
    await unwatch();
  }
});
