import { add, TaskCount, TaskList } from "$lib/tasks.server";
import { head } from "@ilha/router";

const addItem = async (event: SubmitEvent) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  const text = String(new FormData(form).get("text") ?? "").trim();
  if (text) {
    await add(text);
  }
  form.reset();
};

export default function Home() {
  head({ title: "Home" });

  return (
    <div class="mx-auto mt-8 flex max-w-xl flex-col gap-4">
      <div class="card bg-base-100 shadow">
        <div class="card-body gap-4">
          <div class="card-title flex items-center gap-2">
            <h2 class="m-0">To Do</h2>
            <TaskCount />
          </div>
          <form onsubmit={addItem} class="flex items-center gap-2">
            <input
              name="text"
              class="input input-bordered w-full"
              placeholder="Add a new todo"
            />
            <button type="submit" class="btn btn-primary">
              Add
            </button>
          </form>
          <TaskList />
        </div>
      </div>
    </div>
  );
}
