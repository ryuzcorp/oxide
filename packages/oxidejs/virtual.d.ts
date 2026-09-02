declare module "virtual:oxide/actions" {
  import type { Rpc, RpcGroup } from "effect/unstable/rpc";
  import type { Layer } from "effect";

  const actionsGroup: RpcGroup.RpcGroup<Rpc.Any>;
  export const actionsHandlers: Layer.Layer<unknown, unknown, unknown>;
  export default actionsGroup;
  export { actionsGroup as actions };
}

declare module "virtual:oxide/client" {
  export const client: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
}
