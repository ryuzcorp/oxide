import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "transport/fetch": "src/transport/fetch.ts",
    "transport/ws": "src/transport/ws.ts",
    "client/http": "src/client/http.ts",
    "client/ws": "src/client/ws.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
  outDir: "dist",
  sourcemap: true,
});
