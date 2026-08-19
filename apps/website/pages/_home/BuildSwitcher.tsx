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
    <div class="overflow-hidden rounded-none border border-border bg-card">
      <div class="flex items-center justify-start gap-1 border-b border-border bg-transparent p-0">
        {(["vite", "rsbuild"] as const).map((bundler) => (
          <button
            class={
              state.bundler() === bundler
                ? "flex-none rounded-none border-b-2 border-primary bg-transparent px-3 py-2 font-mono font-medium text-xs text-foreground"
                : "flex-none rounded-none border-b-2 border-transparent bg-transparent px-3 py-2 font-mono text-xs text-muted-foreground hover:text-foreground"
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
