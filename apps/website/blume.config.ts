import { fileURLToPath } from "node:url";

import { getRenderer, getViteConfig } from "@ilha/astro";
import { defineConfig } from "blume";
import { script } from "blume/analytics";

export default defineConfig({
  analytics: [
    script({
      attributes: {
        "data-website-id": "a6f30bfd-7ef3-49f5-901c-b9ce066cd824",
      },
      src: "https://umami.guarana.studio/script.js",
      strategy: "defer",
    }),
  ],
  deployment: {
    site: "https://oxide.build",
  },
  description: "The backend unframework.",
  github: { dir: "apps/website", owner: "ryuzcorp", repo: "oxide" },
  integrations: [
    {
      // Same as `@ilha/astro`'s default export. Blume loads this file through
      // jiti with `interopDefault: false`, where that default resolves to the
      // module namespace, so wire the named exports directly.
      hooks: {
        "astro:config:setup": ({ addRenderer, updateConfig }) => {
          addRenderer(getRenderer());
          updateConfig({ vite: getViteConfig() });
        },
      },
      name: "@ilha/astro",
    },
    {
      // PageLayout imports Header directly and has no layout slot, so alias
      // both RootLayout and PageLayout onto our copy.
      hooks: {
        "astro:config:setup": ({ updateConfig }) => {
          const headerPath = fileURLToPath(
            new URL("components/blume/header.astro", import.meta.url)
          );
          updateConfig({
            vite: {
              resolve: {
                alias: [
                  { find: /^\.\/Header\.astro$/u, replacement: headerPath },
                ],
              },
            },
          });
        },
      },
      name: "header-override",
    },
  ],
  logo: "/logo.svg",
  navigation: {
    tabs: [{ href: "/getting-started", label: "Docs", path: "/" }],
  },
  title: "Oxide",
});
