import { cloudflare } from "@cloudflare/vite-plugin";
import { pages } from "@ilha/router/vite";
import tailwindcss from "@tailwindcss/vite";
import oxide from "oxidejs/vite";
import { withOxide } from "oxidejs/wrangler";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    oxide({
      actions: "ws",
      middleware: ["./src/middleware/db.ts", "@ilha/router/ssr"],
      plugins: ["oxidejs/plugins/celld"],
    }),
    cloudflare(withOxide()),
    pages(),
    tailwindcss(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
