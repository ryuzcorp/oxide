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
import celldPlugin, { isCelldPrepareEnabled } from "./plugins/celld";
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
    expect(resolvePluginModuleId("oxidejs/plugins/celld", root)).toBe(
      "oxidejs/plugins/celld"
    );
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

  test("isCelldPrepareEnabled requires OXIDE_CELLD", () => {
    expect(isCelldPrepareEnabled({})).toBe(false);
    expect(isCelldPrepareEnabled({ OXIDE_CELLD: "0" })).toBe(false);
    expect(isCelldPrepareEnabled({ OXIDE_CELLD: "1" })).toBe(true);
    expect(isCelldPrepareEnabled({ OXIDE_CELLD: "true" })).toBe(true);
  });

  test("celld plugin prepares when enabled and ssr/wrangler.json exists", () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-celld-plugin-"));
    const prev = process.env["OXIDE_CELLD"];
    process.env["OXIDE_CELLD"] = "1";
    try {
      fs.mkdirSync(path.join(dist, "ssr"), { recursive: true });
      fs.mkdirSync(path.join(dist, "client"), { recursive: true });
      fs.writeFileSync(
        path.join(dist, "ssr", "index.js"),
        `export default {}\n`
      );
      fs.writeFileSync(
        path.join(dist, "ssr", "wrangler.json"),
        `${JSON.stringify({
          assets: { binding: "ASSETS", directory: "../client" },
          main: "index.js",
          name: "kit",
          workers_dev: true,
        })}\n`
      );
      celldPlugin.afterBuild?.({
        outDir: dist,
        preset: "worker",
        root: path.dirname(dist),
      });
      expect(fs.existsSync(path.join(dist, "wrangler.json"))).toBe(true);
      // SAFETY: prepareCelldDeploy writes JSON.
      const written = JSON.parse(
        fs.readFileSync(path.join(dist, "wrangler.json"), "utf-8")
      ) as { main?: string };
      expect(written.main).toBe("ssr/celld-entry.js");
    } finally {
      if (prev === undefined) {
        delete process.env["OXIDE_CELLD"];
      } else {
        process.env["OXIDE_CELLD"] = prev;
      }
      fs.rmSync(dist, { force: true, recursive: true });
    }
  });

  test("celld plugin no-ops without OXIDE_CELLD even when snapshot exists", () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-celld-skip-"));
    const prev = process.env["OXIDE_CELLD"];
    delete process.env["OXIDE_CELLD"];
    try {
      fs.mkdirSync(path.join(dist, "ssr"), { recursive: true });
      fs.writeFileSync(
        path.join(dist, "ssr", "wrangler.json"),
        `${JSON.stringify({ main: "index.js", name: "kit" })}\n`
      );
      celldPlugin.afterBuild?.({
        outDir: dist,
        preset: "worker",
        root: path.dirname(dist),
      });
      expect(fs.existsSync(path.join(dist, "wrangler.json"))).toBe(false);
      expect(fs.existsSync(path.join(dist, "ssr", "celld-entry.js"))).toBe(
        false
      );
    } finally {
      if (prev === undefined) {
        delete process.env["OXIDE_CELLD"];
      } else {
        process.env["OXIDE_CELLD"] = prev;
      }
      fs.rmSync(dist, { force: true, recursive: true });
    }
  });
});
