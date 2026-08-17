import ilha, { raw } from "ilha";
import { highlight } from "./highlight";

const snippets = {
  vite: `import { defineConfig } from "vite";
import oxide from "oxidejs/vite";

export default defineConfig({
  plugins: [oxide()],
});`,
  rsbuild: `import { defineConfig } from "@rsbuild/core";
import oxide from "oxidejs/rsbuild";

export default defineConfig({
  plugins: [oxide()],
});`,
} as const;

const html = {
  vite: highlight(snippets.vite, "ts"),
  rsbuild: highlight(snippets.rsbuild, "ts"),
};

type Bundler = keyof typeof snippets;

export const BuildSwitcher = ilha
  .state("bundler", "vite" as Bundler)
  .action("select", (bundler: Bundler, { state }) => {
    state.bundler(bundler);
  })
  .render(({ state, action }) => (
    <div class="overflow-hidden rounded-xl border border-border bg-card">
      <div class="flex items-center gap-1 border-border border-b px-3 py-2">
        {(["vite", "rsbuild"] as const).map((bundler) => (
          <button
            class={
              state.bundler() === bundler
                ? "rounded-md bg-muted px-2.5 py-1 font-medium text-foreground text-xs"
                : "rounded-md px-2.5 py-1 text-muted-foreground text-xs hover:text-foreground"
            }
            onclick={() => action.select(bundler)}
            type="button"
          >
            {bundler === "vite" ? "Vite" : "Rsbuild"}
          </button>
        ))}
      </div>
      <div class="p-4 font-mono text-[13px] leading-6">{raw(html[state.bundler()])}</div>
    </div>
  ));
