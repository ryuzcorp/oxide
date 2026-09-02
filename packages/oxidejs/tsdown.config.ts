import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    plugin: "src/plugin.ts",
    vite: "src/vite.ts",
    rsbuild: "src/rsbuild.ts",
    "rpc/client": "src/rpc/client.ts",
    rpc: "src/rpc/index.ts",
    "worker-dom": "src/worker-dom.ts",
    "worker-dom/install": "src/worker-dom/install.ts",
  },
  dts: true,
  format: "esm",
  platform: "node",
  external: [
    "unplugin",
    "effect",
    "effect/unstable/rpc",
    "effect/unstable/http",
    "effect/unstable/socket",
    "crossws/adapters/node",
  ],
});
