import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    vite: "src/vite.ts",
    rsbuild: "src/rsbuild.ts",
  },
  dts: true,
  format: "esm",
  platform: "node",
  external: ["unplugin", "tacho", "tacho/transport/fetch", "tacho/client/http"],
});
