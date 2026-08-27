import { add, TaskCount, TaskList } from "$lib/tasks.server";
import { loader } from "@ilha/router";
import { Button, Input, LayerCard } from "areia";
import { ilha, state } from "ilha";

export const load = loader.client(({ head }) => {
  head({ title: "Home" });
});

export default ilha(() => {
  const draft = state("");

  const addItem = async (event: SubmitEvent) => {
    event.preventDefault();
    const text = draft().trim();
    if (text) await add(text);
    draft("");
  };

  return (
    <div class="mx-auto mt-8 flex max-w-xl flex-col gap-4">
      <LayerCard>
        <LayerCard.Title>
          <span>To Do</span>
          <TaskCount />
        </LayerCard.Title>
        <LayerCard.Content>
          <form onsubmit={addItem}>
            <div class="flex items-center gap-2">
              <Input placeholder="Add a new todo" class="w-full" bind:value={draft} />
              <Button type="submit">Add</Button>
            </div>
          </form>
          <TaskList />
        </LayerCard.Content>
      </LayerCard>
    </div>
  );
});
