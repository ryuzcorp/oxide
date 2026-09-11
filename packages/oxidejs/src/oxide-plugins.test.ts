import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  resolveOxidePlugins,
  resolvePluginModuleId,
  runOxidePluginHook,
  shouldRunAfterBuild,
  toOxideBuildContext,
} from "./oxide-plugins";
import type { OxidePlugin, ResolvedOptions } from "./types";

describe("oxide plugins", () => {
  test("resolveOxidePlugins passes objects through and loads default exports", async () => {
    const local: OxidePlugin = { name: "local" };
    const resolved = await resolveOxidePlugins([local]);
    expect(resolved).toEqual([local]);
  });

  test("resolvePluginModuleId resolves relative paths against the app root", () => {
    const root = "/app/project";
    expect(resolvePluginModuleId("./plugins/mine.ts", root)).toBe(
      pathToFileURL(path.resolve(root, "./plugins/mine.ts")).href
    );
    expect(resolvePluginModuleId("my-pkg/plugin", root)).toBe("my-pkg/plugin");
  });

  test("resolveOxidePlugins loads a relative plugin from the app root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-plugin-rel-"));
    try {
      const file = path.join(root, "mine-plugin.ts");
      fs.writeFileSync(
        file,
        `export default { name: "mine", beforeBuild() {} };\n`
      );
      const resolved = await resolveOxidePlugins(["./mine-plugin.ts"], root);
      expect(resolved[0]?.name).toBe("mine");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("runOxidePluginHook runs beforeBuild then afterBuild in order", async () => {
    const calls: string[] = [];
    const plugin: OxidePlugin = {
      afterBuild() {
        calls.push("after");
      },
      beforeBuild() {
        calls.push("before");
      },
      name: "order",
    };
    const ctx = {
      outDir: "/tmp/out",
      preset: "worker" as const,
      root: "/tmp",
    };
    await runOxidePluginHook([plugin], "beforeBuild", ctx);
    await runOxidePluginHook([plugin], "afterBuild", ctx);
    expect(calls).toEqual(["before", "after"]);
  });

  test("shouldRunAfterBuild waits for client when present", () => {
    expect(shouldRunAfterBuild("ssr", true)).toBe(false);
    expect(shouldRunAfterBuild("client", true)).toBe(true);
    expect(shouldRunAfterBuild("ssr", false)).toBe(true);
    expect(shouldRunAfterBuild("server", false)).toBe(true);
    expect(shouldRunAfterBuild(undefined, false)).toBe(true);
  });

  test("toOxideBuildContext picks root/outDir/preset", () => {
    // SAFETY: test stub — only the fields toOxideBuildContext reads.
    const opts = {
      outDir: "/app/dist",
      preset: "fetch",
      root: "/app",
    } as ResolvedOptions;
    expect(toOxideBuildContext(opts)).toEqual({
      outDir: "/app/dist",
      preset: "fetch",
      root: "/app",
    });
  });
});
