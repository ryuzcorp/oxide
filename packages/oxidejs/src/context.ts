import { AsyncLocalStorage } from "node:async_hooks";

const ALS_KEY = "__oxidejsRequest";

type AlsGlobal = typeof globalThis & {
  [ALS_KEY]?: AsyncLocalStorage<Request>;
};

function als(): AsyncLocalStorage<Request> {
  const g = globalThis as AlsGlobal;
  return (g[ALS_KEY] ??= new AsyncLocalStorage<Request>());
}

/** Current action `Request`. Throws outside `*.server.ts` running over `/_action`. */
export function useRequest(): Request {
  const req = als().getStore();
  if (!req) throw new Error("oxidejs: useRequest() called outside an action");
  return req;
}

export function runWithRequest<T>(req: Request, fn: () => T): T {
  return als().run(req, fn);
}
