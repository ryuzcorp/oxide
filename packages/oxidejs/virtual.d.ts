declare module "virtual:oxide/actions" {
  import type { Layer } from "effect";
  import type { Rpc, RpcGroup } from "effect/unstable/rpc";

  const actionsGroup: RpcGroup.RpcGroup<Rpc.Any>;
  export const actionsHandlers: Layer.Layer<Rpc.Any, never, never>;
  export default actionsGroup;
  export { actionsGroup as actions };
}

declare module "virtual:oxide/client" {
  type ActionFn = (...args: never[]) => Promise<never>;
  type ActionModule = Record<string, ActionFn>;
  export const client: Record<string, ActionModule>;
}
