import { defineConfig } from "tsdown";

export default defineConfig({
  deps: {
    neverBundle: [
      "unplugin",
      "effect",
      "effect/unstable/rpc",
      "effect/unstable/http",
      "effect/unstable/socket",
      "crossws/adapters/node",
    ],
  },
  dts: true,
  entry: {
    index: "src/index.ts",
    "mutation-queue": "src/mutation-queue.ts",
    plugin: "src/plugin.ts",
    "plugins/celld": "src/plugins/celld.ts",
    rpc: "src/rpc/index.ts",
    "rpc/client": "src/rpc/client.ts",
    rsbuild: "src/rsbuild.ts",
    vite: "src/vite.ts",
    "worker-dom": "src/worker-dom.ts",
    "worker-dom/install": "src/worker-dom/install.ts",
    wrangler: "src/wrangler.ts",
  },
  format: "esm",
  platform: "node",
});
