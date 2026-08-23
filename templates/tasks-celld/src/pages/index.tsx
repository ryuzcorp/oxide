import ilha from "ilha";
import { add, TaskList } from "../tasks.server";

export default ilha
  .action("add", async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const text = String(new FormData(form).get("text") ?? "").trim();
    if (!text) return;
    form.reset();
    await add(text);
  })
  .render(({ action }) => (
    <div>
      <div>Task list</div>
      <form onsubmit={action.add}>
        <input name="text" />
        <button type="submit">Add Task</button>
      </form>
      <TaskList />
    </div>
  ));
