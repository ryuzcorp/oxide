import { defineConfig } from "blume";
import ilha from "@ilha/astro";

export default defineConfig({
  title: "Oxide",
  description: "The backend unframework.",
  logo: "/logo.svg",
  github: { owner: "ryuzcorp", repo: "oxide", dir: "apps/website" },
  integrations: [ilha()],
  navigation: {
    tabs: [{ label: "Docs", path: "/", href: "/getting-started" }],
  },
  deployment: {
    site: "https://oxide.build",
  },
});
