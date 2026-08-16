declare module "tacho/transport/fetch" {
  export function handle(
    router: unknown,
    opts?: { path?: string },
  ): (request: Request) => Promise<Response>;
}
