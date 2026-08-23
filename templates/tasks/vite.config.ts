import { defineConfig } from "vite";
import oxide from "oxidejs/vite";
import { pages } from "@ilha/router/vite";

export default defineConfig({
  plugins: [oxide({ middleware: ["@ilha/router/ssr"] }), pages()],
  resolve: {
    tsconfigPaths: true,
  },
});
