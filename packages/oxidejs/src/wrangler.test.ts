/* eslint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-unknown-parameters -- wrangler JSON fixtures and Cloudflare config customizers are untyped bags */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isCelldUnsupportedKey,
  mergeDevVarsIntoConfig,
  parseDevVars,
  prepareCelldDeploy,
  relocateCloudflareViteWrangler,
  stripCelldBareNodeImports,
  toCelldWrangler,
  withOxide,
  writeCelldWrangler,
} from "./wrangler";
import type { CelldWranglerConfig, DurableWranglerConfig } from "./wrangler";

describe("withOxide", () => {
  test("merges durable bindings and preserves other options", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-withoxide-"));
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "src", "demo.server.ts"),
        `
import { workflow } from "oxidejs";
export const demo = workflow({
  name: "demo",
  run: async () => {},
});
`
      );
      const cwd = process.cwd();
      process.chdir(root);
      try {
        const opts = withOxide();
        expect(opts.viteEnvironment).toEqual({ name: "ssr" });
        const config: DurableWranglerConfig = {};
        // SAFETY: withOxide always installs a function config customizer.
        const result = (opts.config as (c: DurableWranglerConfig) => unknown)(
          config
        );
        expect(result).toBeUndefined();
        expect(config.workflows).toEqual([
          { binding: "DEMO", class_name: "DemoWorkflow", name: "demo" },
        ]);
      } finally {
        process.chdir(cwd);
      }
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("lets viteEnvironment overrides win over the ssr default", () => {
    expect(
      withOxide({ viteEnvironment: { name: "api" } }).viteEnvironment
    ).toEqual({ name: "api" });
    expect(
      withOxide({
        viteEnvironment: { childEnvironments: ["rsc"] },
      }).viteEnvironment
    ).toEqual({ childEnvironments: ["rsc"], name: "ssr" });
  });

  test("scans durable bindings from an explicit root", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "oxide-withoxide-root-")
    );
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "src", "demo.server.ts"),
        `
import { workflow } from "oxidejs";
export const demo = workflow({
  name: "demo",
  run: async () => {},
});
`
      );
      const opts = withOxide({ root });
      expect("root" in opts).toBe(false);
      const config: DurableWranglerConfig = {};
      // SAFETY: withOxide always installs a function config customizer.
      (opts.config as (c: DurableWranglerConfig) => unknown)(config);
      expect(config.workflows).toEqual([
        { binding: "DEMO", class_name: "DemoWorkflow", name: "demo" },
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("runs user config function after merge and forwards args", () => {
    const opts = withOxide({
      config: (config: DurableWranglerConfig, ctx: unknown) => {
        // SAFETY: test fixture stamps a marker the assertion reads back.
        (config as DurableWranglerConfig & { marked?: boolean }).marked = true;
        expect(ctx).toEqual({ entryWorkerConfig: { name: "entry" } });
      },
    });
    const config: DurableWranglerConfig = {};
    const ctx = { entryWorkerConfig: { name: "entry" } };
    // SAFETY: withOxide always installs a function config customizer.
    (opts.config as (c: DurableWranglerConfig, ctx: unknown) => unknown)(
      config,
      ctx
    );
    // SAFETY: marker stamped by the customizer above.
    expect(
      (config as DurableWranglerConfig & { marked?: boolean }).marked
    ).toBe(true);
  });

  test("returns user config object for Cloudflare defu merge", () => {
    const overrides = { vars: { A: "1" } };
    const opts = withOxide({ config: overrides });
    const config: DurableWranglerConfig = {};
    // SAFETY: withOxide always installs a function config customizer.
    const result = (opts.config as (c: DurableWranglerConfig) => unknown)(
      config
    );
    expect(result).toBe(overrides);
  });
});

describe("parseDevVars", () => {
  test("parses keys, quotes, and skips comments", () => {
    expect(
      parseDevVars(
        `# comment\nBETTER_AUTH_SECRET=abc\nEMPTY=\nQUOTED="x y"\nBAD\n`
      )
    ).toEqual({
      BETTER_AUTH_SECRET: "abc",
      EMPTY: "",
      QUOTED: "x y",
    });
  });
});

describe("mergeDevVarsIntoConfig", () => {
  test("merges .dev.vars under the project root; wrangler vars win", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-devvars-"));
    const dist = path.join(project, "dist");
    try {
      fs.mkdirSync(dist);
      fs.writeFileSync(
        path.join(project, ".dev.vars"),
        "FROM_FILE=file\nSHARED=file\nFLAG=false\n"
      );
      const merged = mergeDevVarsIntoConfig(
        {
          name: "kit",
          vars: { FLAG: true, NESTED: { a: 1 }, SHARED: "wrangler" },
        },
        dist
      );
      expect(merged["vars"]).toEqual({
        FLAG: true,
        FROM_FILE: "file",
        NESTED: { a: 1 },
        SHARED: "wrangler",
      });
    } finally {
      fs.rmSync(project, { force: true, recursive: true });
    }
  });
});

describe("toCelldWrangler", () => {
  test("keeps celld keys and drops Cloudflare Vite snapshot noise", () => {
    const cleaned = toCelldWrangler({
      assets: { binding: "ASSETS", directory: "../client" },
      compatibility_date: "2026-01-01",
      compatibility_flags: ["nodejs_compat"],
      configPath: "/tmp/wrangler.jsonc",
      d1_databases: [{ binding: "DB", database_name: "kit" }],
      definedEnvironments: [],
      dev: { ip: "localhost" },
      jsx_factory: "React.createElement",
      main: "index.js",
      name: "kit",
      no_bundle: true,
      queues: { consumers: [{ queue: "demos" }], producers: [] },
      r2_buckets: [{ binding: "FILES", bucket_name: "files" }],
      topLevelName: "kit",
      triggers: { crons: ["0 * * * *"] },
      userConfigPath: "/tmp/wrangler.jsonc",
      vars: { SECRET: "x" },
      workers_dev: true,
      workflows: [
        { binding: "DEMO", class_name: "DemoWorkflow", name: "demo" },
      ],
    });
    expect(cleaned).toEqual({
      assets: { binding: "ASSETS", directory: "../client" },
      compatibility_date: "2026-01-01",
      compatibility_flags: ["nodejs_compat"],
      d1_databases: [{ binding: "DB", database_name: "kit" }],
      main: "index.js",
      name: "kit",
      queues: { consumers: [{ queue: "demos" }], producers: [] },
      r2_buckets: [{ binding: "FILES", bucket_name: "files" }],
      triggers: { crons: ["0 * * * *"] },
      vars: { SECRET: "x" },
      workflows: [
        { binding: "DEMO", class_name: "DemoWorkflow", name: "demo" },
      ],
    });
    expect(isCelldUnsupportedKey("workers_dev")).toBe(true);
    expect(isCelldUnsupportedKey("no_bundle")).toBe(true);
    expect(isCelldUnsupportedKey("d1_databases")).toBe(false);
  });

  test("writeCelldWrangler rewrites the file in place", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-celld-"));
    const file = path.join(dir, "wrangler.json");
    try {
      fs.writeFileSync(
        file,
        `${JSON.stringify(
          {
            configPath: "x",
            main: "index.js",
            name: "kit",
            workers_dev: true,
          },
          null,
          2
        )}\n`
      );
      writeCelldWrangler(file);
      // SAFETY: test fixture is JSON written by this test.
      const written = JSON.parse(
        fs.readFileSync(file, "utf-8")
      ) as CelldWranglerConfig;
      expect(written).toEqual({ main: "index.js", name: "kit" });
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("relocateCloudflareViteWrangler", () => {
  test("rewrites ssr-relative paths for a dist/ deploy root", () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-celld-dist-"));
    try {
      const cleaned = relocateCloudflareViteWrangler(
        {
          assets: {
            binding: "ASSETS",
            directory: "../client",
            run_worker_first: true,
          },
          d1_databases: [
            {
              binding: "DB",
              database_name: "kit",
              migrations_dir: "../../migrations",
            },
          ],
          main: "index.js",
          name: "kit",
          workers_dev: true,
        },
        dist
      );
      expect(cleaned["main"]).toBe("ssr/index.js");
      expect(cleaned["assets"]).toEqual({
        binding: "ASSETS",
        directory: "client",
        run_worker_first: true,
      });
      expect(cleaned["d1_databases"]).toEqual([
        { binding: "DB", database_name: "kit" },
      ]);
      expect(cleaned["workers_dev"]).toBeUndefined();
    } finally {
      fs.rmSync(dist, { force: true, recursive: true });
    }
  });

  test("drops escaping main instead of leaving it", () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-celld-escape-"));
    try {
      const cleaned = relocateCloudflareViteWrangler(
        {
          main: "../../evil.js",
          name: "kit",
        },
        dist
      );
      expect(cleaned["main"]).toBeUndefined();
    } finally {
      fs.rmSync(dist, { force: true, recursive: true });
    }
  });

  test("prepareCelldDeploy writes dist/wrangler.json", () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-celld-prep-"));
    try {
      fs.mkdirSync(path.join(dist, "ssr"), { recursive: true });
      fs.mkdirSync(path.join(dist, "client"), { recursive: true });
      fs.writeFileSync(
        path.join(dist, "ssr", "index.js"),
        `import "node:fs";\nimport "node:path";\nimport { EventEmitter } from "node:events";\nexport default {}\n`
      );
      fs.writeFileSync(
        path.join(dist, "client", ".assetsignore"),
        "wrangler.json\n.dev.vars\n"
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
      prepareCelldDeploy(dist);
      // SAFETY: prepareCelldDeploy writes JSON.
      const written = JSON.parse(
        fs.readFileSync(path.join(dist, "wrangler.json"), "utf-8")
      ) as CelldWranglerConfig;
      expect(written).toEqual({
        assets: { binding: "ASSETS", directory: "client" },
        main: "ssr/celld-entry.js",
        name: "kit",
      });
      expect(fs.existsSync(path.join(dist, "client", ".assetsignore"))).toBe(
        false
      );
      const celldEntry = fs.readFileSync(
        path.join(dist, "ssr", "celld-entry.js"),
        "utf-8"
      );
      expect(celldEntry).not.toContain('import "node:fs"');
      expect(celldEntry).not.toContain('import "node:path"');
      expect(celldEntry).toContain('from "node:events"');
      expect(
        fs.readFileSync(path.join(dist, "ssr", "index.js"), "utf-8")
      ).toContain('import "node:fs"');
    } finally {
      fs.rmSync(dist, { force: true, recursive: true });
    }
  });

  test("prepareCelldDeploy rejects when main escapes dist", () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "oxide-celld-bad-"));
    try {
      fs.mkdirSync(path.join(dist, "ssr"), { recursive: true });
      fs.writeFileSync(
        path.join(dist, "ssr", "wrangler.json"),
        `${JSON.stringify({ main: "../../evil.js", name: "kit" })}\n`
      );
      expect(() => prepareCelldDeploy(dist)).toThrow(/needs a Worker main/u);
    } finally {
      fs.rmSync(dist, { force: true, recursive: true });
    }
  });
});

describe("stripCelldBareNodeImports", () => {
  test("drops bare fs/path side-effect imports only", () => {
    expect(
      stripCelldBareNodeImports(
        `import "node:fs";\nimport "node:path";\nimport fs from "node:fs";\n`
      )
    ).toBe(`import fs from "node:fs";\n`);
  });
});
