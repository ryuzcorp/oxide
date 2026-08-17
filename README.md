# Oxide

The backend unframework.

Ship a backend from the bundler you already use. Call the server from the client like a function.

```ts
// notes.server.ts
export async function create(title: string) {
  return { id: crypto.randomUUID(), title };
}

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
npm i oxidejs tacho
```

It guides you. It doesn't frame you.

- **Single bundle** — One folder to deploy. A server, and a client if you have a page.
- **Server actions** — Import a server function. Call it like it's local.
- **Your host** — Same plugin on a VPS or on Cloudflare. You pick the host, not a new stack.

## Packages

| Package                     | What it is                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [oxidejs](packages/oxidejs) | Vite/Rsbuild plugin. One build → `dist/server.js` and optional `dist/client/`. Actions from `*.server.ts`. |
| [tacho](packages/tacho)     | Typed JSON-RPC. The wire those actions ride on. Also usable on its own.                                    |

Need RPC without the plugin? Use [tacho](packages/tacho). `typeof router` is the client.

[Docs](https://oxide.build) · [oxidejs](packages/oxidejs) · [tacho](packages/tacho)

## License

[MIT](LICENSE) © Ryuz
