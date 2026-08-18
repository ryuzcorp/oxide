declare module "tacho/transport/fetch" {
  export function handle(
    router: unknown,
    opts?: { path?: string; createContext?: (req: Request) => unknown },
  ): (request: Request) => Promise<Response>;
}

declare module "tacho/transport/ws" {
  export function handle(router: unknown, opts?: { path?: string }): unknown;
}

declare module "tacho/client/ws" {
  export function createClient(opts: { url: string }): unknown;
}

declare module "crossws/adapters/node" {
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";
  export default function crossws(opts: { hooks: unknown }): {
    handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>;
  };
}
