import { defineConfig } from "vite";
import oxide from "oxidejs/vite";
import { pages } from "@ilha/router/vite";

export default defineConfig({
  plugins: [oxide(), pages()],
  resolve: {
    tsconfigPaths: true,
  },
});
