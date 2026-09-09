import { pages } from "@ilha/router/vite";
import tailwindcss from "@tailwindcss/vite";
import oxide from "oxidejs/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    oxide({
      actions: "ws",
      middleware: ["./src/middleware/db.ts", "@ilha/router/ssr"],
      preset: "worker",
      wrangler: {
        compatibility_date: "2026-01-01",
        d1_databases: [
          {
            binding: "DB",
            database_id: "00000000-0000-0000-0000-000000000000",
            database_name: "kit",
          },
        ],
        name: "kit",
        r2_buckets: [
          {
            binding: "FILES",
            bucket_name: "kit-files",
          },
        ],
        // Replace before deploy. Local celld / wrangler read these from wrangler.jsonc.
        vars: {
          BETTER_AUTH_SECRET: "CV90vWOJ+rEvIVayJqbr0vXdmFptnEC8Xg7DUPn0ysY=",
        },
      },
    }),
    pages(),
    tailwindcss(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
