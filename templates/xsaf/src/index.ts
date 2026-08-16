import { router, tacho } from "tacho";
import { handle } from "tacho/transport/fetch";

const rpc = tacho();

const app = router({
  ping: rpc.run(() => "pong" as const),
});

export type Router = typeof app;

export default {
  fetch: handle(app),
};
