import * as Stream from "effect/Stream";
import { atom, watch } from "ilha";
import { createMutationQueue } from "oxidejs/mutation-queue";

import { authClient, hardNav } from "./auth-client";
import type { Task } from "./db";
import { add, list, remove, toggle } from "./tasks.server";

const toStreamError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const queue = createMutationQueue();
const addQueued = queue.wrap(add, {
  idempotencyKey: ({ text }) => `add:${text}`,
});
const toggleQueued = queue.wrap(toggle, {
  idempotencyKey: (id) => `toggle:${id}`,
});
const removeQueued = queue.wrap(remove, {
  idempotencyKey: (id) => `remove:${id}`,
});

const addItem = async (event: SubmitEvent) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  const text = String(new FormData(form).get("text") ?? "").trim();
  if (text) {
    await addQueued({ text });
  }
  form.reset();
};

const TaskList = () =>
  Stream.map(
    Stream.fromAsyncIterable(list(), toStreamError),
    (items: Task[]) => (
      <>
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
        <div class="card-title flex items-center gap-2">
          <h2 class="m-0">To Do</h2>
          <span class="badge badge-primary">
            {items.filter((task) => !task.completed).length}
          </span>
        </div>
        <div class="flex flex-col gap-2">
          {items.length > 0 ? (
            items.map((todo) => (
              <div
                key={todo.id}
                class="flex items-center justify-between gap-2"
              >
                <label class="label cursor-pointer justify-start gap-2">
                  <input
                    type="checkbox"
                    class="checkbox"
                    checked={todo.completed}
                    onchange={async () => {
                      await toggleQueued(todo.id);
                    }}
                  />
                  <span>{todo.text}</span>
                </label>
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  onclick={async () => {
                    await removeQueued(todo.id);
                  }}
                >
                  Delete
                </button>
              </div>
            ))
          ) : (
            <p>No todos.</p>
          )}
        </div>
      </>
    )
  );

/** Signed-in task UI — redirects to `/login` when there is no session. */
export const Tasks = () => {
  const ready = atom(false);
  const label = atom("");
  const busy = atom(false);
  const fail = atom("");

  watch.once(() => {
    void (async () => {
      const { data, error } = await authClient.getSession();
      // Auth misconfig (e.g. missing BETTER_AUTH_SECRET → 500) must not
      // hard-navigate — that reconnect-loops /login while the page remounts.
      if (error) {
        fail.set(error.message ?? "Session check failed");
        return;
      }
      if (!data?.user) {
        hardNav("/login");
        return;
      }
      label.set(data.user.name || data.user.email);
      ready.set(true);
    })();
  });

  const signOut = async () => {
    busy.set(true);
    await authClient.signOut();
    hardNav("/login");
  };

  if (fail()) {
    return <p class="text-error text-sm">{fail()}</p>;
  }

  if (!ready()) {
    return <p class="text-sm opacity-70">Loading…</p>;
  }

  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-2">
        <p class="text-sm opacity-70">{label()}</p>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          disabled={busy()}
          onclick={signOut}
        >
          Sign out
        </button>
      </div>
      <TaskList />
    </div>
  );
};
