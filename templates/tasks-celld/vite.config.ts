import { defineConfig } from "vite";
import oxide from "oxidejs/vite";
import { pages } from "@ilha/router/vite";

export default defineConfig({
  plugins: [
    oxide({
      middleware: ["@ilha/router/ssr"],
      preset: "celld",
      wrangler: {
        name: "celld-tasks",
        compatibility_date: "2026-01-01",
        durable_objects: {
          bindings: [{ name: "TASKS", class_name: "TasksDO" }],
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["TasksDO"] }],
      },
    }),
    pages(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
