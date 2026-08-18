import ilha from "ilha";
import type { Task } from "../server";
import { add, list, remove, type TaskEvent } from "../tasks.server";

export default ilha
  .state("tasks", [] as Task[])
  .action("add", async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const text = String(new FormData(form).get("text") ?? "").trim();
    if (!text) return;
    form.reset();
    await add(text);
  })
  .action("remove", (id: string) => remove(id))
  .action("apply", (event: TaskEvent, { state }) => {
    if (event.type === "snapshot") state.tasks(event.tasks);
    else if (event.type === "set") {
      state.tasks((tasks) => {
        const next = tasks.filter((task) => task.id !== event.task.id);
        next.push(event.task);
        return next;
      });
    } else state.tasks((tasks) => tasks.filter((task) => task.id !== event.id));
  })
  .onMount(({ action, host }) => {
    if (!host.isConnected) return;
    const ac = new AbortController();
    // @ts-expect-error: RPC client stub returns a Promise<AsyncGenerator>
    list({ signal: ac.signal }).then(async (stream) => {
      for await (const event of stream) {
        if (ac.signal.aborted) return;
        action.apply(event);
      }
    });
    return () => ac.abort();
  })
  .render(({ state, action }) => (
    <div>
      <div>Task list</div>
      <form onsubmit={action.add}>
        <input name="text" />
        <button type="submit">Add Task</button>
      </form>
      <ul>
        {state.tasks().map((task) => (
          <li>
            {task.text}
            <button type="button" onclick={() => action.remove(task.id)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  ));
