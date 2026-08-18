import { fileURLToPath } from "node:url";
import ilha from "@ilha/astro";
import { defineConfig } from "blume";

export default defineConfig({
  title: "Oxide",
  description: "The backend unframework.",
  logo: "/logo.svg",
  github: { owner: "ryuzcorp", repo: "oxide", dir: "apps/website" },
  integrations: [
    ilha(),
    {
      // PageLayout imports Header directly and has no layout slot, so alias
      // both RootLayout and PageLayout onto our copy.
      name: "header-override",
      hooks: {
        "astro:config:setup": ({ updateConfig }) => {
          const headerPath = fileURLToPath(
            new URL("./components/blume/Header.astro", import.meta.url),
          );
          updateConfig({
            vite: {
              resolve: {
                alias: [{ find: /^\.\/Header\.astro$/u, replacement: headerPath }],
              },
            },
          });
        },
      },
    },
  ],
  navigation: {
    tabs: [{ label: "Docs", path: "/", href: "/getting-started" }],
  },
  deployment: {
    site: "https://oxide.build",
  },
  analytics: {
    scripts: [
      {
        src: "https://umami.guarana.studio/script.js",
        strategy: "defer",
        attributes: {
          "data-website-id": "a6f30bfd-7ef3-49f5-901c-b9ce066cd824",
        },
      },
    ],
  },
});
