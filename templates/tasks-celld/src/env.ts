import type { TasksDO } from "./server";

export interface Env {
  TASKS: DurableObjectNamespace<TasksDO>;
}
