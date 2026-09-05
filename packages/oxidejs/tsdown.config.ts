import { defineConfig } from "tsdown";

export default defineConfig({
  dts: true,
  entry: {
    index: "src/index.ts",
    plugin: "src/plugin.ts",
    rpc: "src/rpc/index.ts",
    "rpc/client": "src/rpc/client.ts",
    rsbuild: "src/rsbuild.ts",
    vite: "src/vite.ts",
    "worker-dom": "src/worker-dom.ts",
    "worker-dom/install": "src/worker-dom/install.ts",
  },
  external: [
    "unplugin",
    "effect",
    "effect/unstable/rpc",
    "effect/unstable/http",
    "effect/unstable/socket",
    "crossws/adapters/node",
  ],
  format: "esm",
  platform: "node",
});
