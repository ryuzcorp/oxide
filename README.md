# Oxide

The backend unframework.

Ship a backend from the bundler you already use. Call the server from the client like a function.

```ts
// notes.server.ts
import { action } from "oxidejs";

export const create = action(async (title: string) => {
  return { id: crypto.randomUUID(), title };
});

// client.ts
import { create } from "./notes.server";

const note = await create("Ship Oxide");
```

Looks local. Runs on the server.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import oxide from "oxidejs/vite";

export default defineConfig({
  plugins: [oxide()],
});
```

Vite or Rsbuild. Switch the import. Keep the rest.

```sh
bun add oxidejs
```

It guides you. It doesn't frame you.

- **Single bundle** — One folder to deploy. A server, and a client if you have a page.
- **Server actions** — Wrap a `*.server.ts` export in `action()`, then import and call it from the client over Effect RPC.
- **Fetch or celld** — Run the generated server on Node-compatible hosts, or emit a celld worker.

## Packages

| Package | Purpose |
| --- | --- |
| [oxidejs](packages/oxidejs) | Turns Vite or Rsbuild into a backend. One plugin, one folder to deploy. |

Server actions ride [Effect](https://effect.website) RPC (`application/json-rpc`). The `templates/simple` and `templates/tasks` apps show fetch and celld deployments.

[Docs](https://oxide.build) · [oxidejs](packages/oxidejs)

## License

[MIT](LICENSE) © Ryuz
