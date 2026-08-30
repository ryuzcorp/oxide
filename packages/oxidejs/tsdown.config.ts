import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    plugin: "src/plugin.ts",
    vite: "src/vite.ts",
    rsbuild: "src/rsbuild.ts",
  },
  dts: true,
  format: "esm",
  platform: "node",
  external: [
    "unplugin",
    "tacho",
    "tacho/transport/fetch",
    "tacho/transport/ws",
    "tacho/client/http",
    "tacho/client/ws",
    "crossws/adapters/node",
  ],
});
