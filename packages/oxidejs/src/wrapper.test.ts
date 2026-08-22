import { describe, expect, test } from "bun:test";

import { generateWorkerWrapper } from "./actions";

const BASE = { preset: "fetch" as const, clientDir: "client", hasClient: true, hasPublic: true };

describe("generateWorkerWrapper", () => {
  test("middleware handlers run before the action gate", () => {
    const out = generateWorkerWrapper("/x/server.ts", {
      ...BASE,
      hasActions: true,
      middleware: ["@ilha/router/ssr"],
    });
    const mw = out.indexOf("for (const __mw of");
    const gate = out.indexOf("request[__fetch] =");
    expect(mw).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(mw);
  });

  test("imports option emits side-effect imports at the top", () => {
    const out = generateWorkerWrapper("/x/server.ts", { ...BASE, imports: ["ilha:pages/server"] });
    const firstImport = out.indexOf("import");
    expect(out.slice(firstImport, firstImport + 60)).toContain('"ilha:pages/server"');
  });

  test("middleware object entries emit their side-effect imports", () => {
    const out = generateWorkerWrapper("/x/server.ts", {
      ...BASE,
      middleware: [{ module: "@ilha/router/ssr", imports: ["ilha:pages/server"] }],
    });
    expect(out).toContain('"ilha:pages/server"');
    expect(out).toContain('"@ilha/router/ssr"');
  });

  test("bodyLimit interpolates into the request cap", () => {
    const out = generateWorkerWrapper("/x/server.ts", { ...BASE, bodyLimit: 4096 });
    expect(out).toContain("if (size > 4096)");
  });

  test("default body cap is 1 MiB", () => {
    const out = generateWorkerWrapper("/x/server.ts", BASE);
    expect(out).toContain("if (size > 1048576)");
  });

  test("graceful shutdown listens for SIGTERM/SIGINT", () => {
    const out = generateWorkerWrapper("/x/server.ts", BASE);
    expect(out).toContain('"SIGTERM"');
    expect(out).toContain("server.close");
  });

  test("notFound option replaces the plain 404 body", () => {
    const out = generateWorkerWrapper("/x/server.ts", { ...BASE, notFound: "<h1>custom</h1>" });
    expect(out).toContain("<h1>custom</h1>");
    expect(out).not.toContain('"Not Found"');
  });

  test("env option passes through to user fetch", () => {
    const out = generateWorkerWrapper("/x/server.ts", { ...BASE, env: { FOO: "1" } });
    expect(out).toContain('"FOO":"1"');
  });

  test("etag + 304 handling present when serving assets", () => {
    const out = generateWorkerWrapper("/x/server.ts", BASE);
    expect(out).toContain("etag");
    expect(out).toContain("304");
  });
});
