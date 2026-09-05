import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  overrides: [
    {
      files: ["**/*.mdx"],
      options: {
        printWidth: 72,
      },
    },
  ],
});
