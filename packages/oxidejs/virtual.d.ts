declare module "virtual:oxide/actions" {
  import type { Layer } from "effect";
  import type { Rpc, RpcGroup } from "effect/unstable/rpc";

  const actionsGroup: RpcGroup.RpcGroup<Rpc.Any>;
  export const actionsHandlers: Layer.Layer<Rpc.Any, never, never>;
  export default actionsGroup;
  export { actionsGroup as actions };
}

declare module "virtual:oxide/workflows" {
  // Named WorkflowEntrypoint exports are generated per `workflow()` in `*.server.ts`.
}

declare module "virtual:oxide/queues" {
  // Cloudflare MessageBatch / Env / ExecutionContext — opaque at the virtual boundary.
  export function handleQueue(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- CF queue handler args
    batch: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- CF queue handler args
    env: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- CF queue handler args
    ctx: unknown
  ): Promise<void>;
}

declare module "virtual:oxide/schedules" {
  export function handleSchedule(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- CF scheduled handler args
    controller: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- CF scheduled handler args
    env: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- CF scheduled handler args
    ctx: unknown
  ): Promise<void>;
}
