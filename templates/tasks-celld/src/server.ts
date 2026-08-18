import { DurableObject } from "cloudflare:workers";

export type Task = { id: string; text: string };

export class TasksDO extends DurableObject {
  async getTasks(): Promise<Task[]> {
    const tasks = await this.ctx.storage.get<Task[]>("tasks");
    return tasks ?? [];
  }

  async addTask(text: string): Promise<Task> {
    const tasks = await this.getTasks();
    const task = { id: crypto.randomUUID(), text };
    tasks.push(task);
    await this.ctx.storage.put("tasks", tasks);
    return task;
  }

  async removeTask(id: string): Promise<void> {
    const tasks = await this.getTasks();
    await this.ctx.storage.put(
      "tasks",
      tasks.filter((t) => t.id !== id),
    );
  }
}

export default {
  fetch() {
    return undefined; // fall through to assets
  },
};
