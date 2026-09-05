import { pages } from "@ilha/router/vite";
import tailwindcss from "@tailwindcss/vite";
import oxide from "oxidejs/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    oxide({
      middleware: ["@ilha/router/ssr"],
      preset: "celld",
      wrangler: {
        compatibility_date: "2026-01-01",
        name: "celld-tasks",
      },
    }),
    pages(),
    tailwindcss(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
