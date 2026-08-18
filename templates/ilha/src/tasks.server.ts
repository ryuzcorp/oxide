// Server Actions - on client side they look like regular functions, but they are executed server side over RPC
import { createStorage } from "unstorage";

const storage = createStorage();

export async function create(task: string) {
  const id = crypto.randomUUID();
  storage.setItem(id, task);
}
