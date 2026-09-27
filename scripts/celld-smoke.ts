#!/usr/bin/env bun
/**
 * celld smoke test for the oxide action server.
 *
 * Bun's test runner cannot reproduce what broke actions on celld: celld drops
 * a request's pending work once that request answers or its client goes away,
 * so anything shared across requests (a runtime, a gate, a promise) can hang
 * every later request. This script generates what the plugin emits for a
 * worker app (the Worker wrapper and the actions module for
 * `packages/oxidejs/test/celld-smoke/smoke.server.ts`), bundles it from
 * source, boots `celld dev` on it, and asserts:
 *
 *   - concurrent async actions all answer, round after round;
 *   - each request sees only its own request context;
 *   - a batch keeps its fast result when another call times out;
 *   - a stuck action answers with the timeout error;
 *   - the isolate still answers afterwards (nothing wedged).
 *
 * Runs twice: without compatibility flags (how apps such as Noite deploy)
 * and with `nodejs_compat`, because celld's request context behaves
 * differently between the two.
 *
 * Needs `celld` and `esbuild` on PATH (or CELLD_BIN / CELLD_ESBUILD).
 *
 *   bun run smoke:celld
 */
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import {
  generateActionsModule,
  generateWorkerWrapper,
  scanServerFiles,
} from "../packages/oxidejs/src/actions";
import { writeGeneratedActions } from "../packages/oxidejs/src/rpc/test-harness";

const APP = path.join(import.meta.dir, "../packages/oxidejs/test/celld-smoke");
const PORT = Number(process.env["CELLD_SMOKE_PORT"] ?? 19_990);
const BASE = `http://127.0.0.1:${PORT}`;
const ACTION = `${BASE}/__oxide/action`;
const CONCURRENCY = 50;
const ROUNDS = 3;
const CALL_LIMIT_MS = 10_000;
const TIMEOUT_MS = 1000;
const READY_LIMIT_MS = 60_000;

interface Frame {
  error?: { message: string };
  id: number | null;
  result?: string;
}

const CONFIGS = ["wrangler.jsonc", "wrangler.nodejs-compat.jsonc"] as const;

const failures: string[] = [];
let currentConfig = "";
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) {
    failures.push(`${currentConfig}: ${label}`);
  }
};

const frames = (text: string): Frame[] =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      // SAFETY: the action endpoint answers JSON-RPC frames, one per line.
      const frame = JSON.parse(line) as Frame;
      return frame;
    });

/** POST a JSON-RPC body; `null` when it does not answer within the limit. */
const post = async (
  body: string,
  headers: Record<string, string> = {}
): Promise<Frame[] | null> => {
  try {
    const res = await fetch(ACTION, {
      body,
      headers,
      method: "POST",
      signal: AbortSignal.timeout(CALL_LIMIT_MS),
    });
    return frames(await res.text());
  } catch {
    return null;
  }
};

const call = (method: string, id = 1) =>
  JSON.stringify({ id, jsonrpc: "2.0", method, params: { args: [] } });

const SRC = path.join(import.meta.dir, "../packages/oxidejs/src");

/** Resolve the generated wrapper's package and virtual imports to the source tree. */
const oxideSource = (actionsModule: string): Bun.BunPlugin => ({
  name: "oxide-source",
  setup: (build) => {
    const targets = new Map<string, string>(
      Object.entries({
        oxidejs: path.join(SRC, "context.ts"),
        "oxidejs/rpc": path.join(SRC, "rpc/index.ts"),
        "oxidejs/worker-dom/install": path.join(SRC, "worker-dom/install.ts"),
        "virtual:oxide/actions": actionsModule,
      })
    );
    build.onResolve(
      {
        filter:
          /^(?:oxidejs(?:\/rpc|\/worker-dom\/install)?|virtual:oxide\/actions)$/u,
      },
      (args) => ({ path: targets.get(args.path) ?? args.path })
    );
  },
});

const bundle = async () => {
  // What the plugin generates for a worker app: the actions module for
  // smoke.server.ts and the Worker wrapper (worker-dom install, request
  // context stamp, action gate) — with its imports pointed at the source tree.
  const buildDir = path.join(APP, ".build");
  mkdirSync(buildDir, { recursive: true });
  const actionsModule = writeGeneratedActions(buildDir, {
    code: generateActionsModule(scanServerFiles(APP)),
  });
  const entry = path.join(buildDir, "entry.mjs");
  await Bun.write(
    entry,
    generateWorkerWrapper(null, {
      actionSameOrigin: false,
      actionTimeout: TIMEOUT_MS,
      hasActions: true,
      preset: "worker",
    })
  );
  const built = await Bun.build({
    entrypoints: [entry],
    external: ["node:*"],
    format: "esm",
    naming: "index.js",
    outdir: path.join(APP, ".build"),
    plugins: [oxideSource(actionsModule)],
    target: "browser",
  });
  if (!built.success) {
    throw new AggregateError(built.logs, "bundling the smoke worker failed");
  }
};

const waitReady = async () => {
  const deadline = Date.now() + READY_LIMIT_MS;
  while (Date.now() < deadline) {
    try {
      // Any HTTP answer means the node serves; the action path wants POST.
      // oxlint-disable-next-line eslint/no-await-in-loop -- readiness poll
      await fetch(ACTION, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      // oxlint-disable-next-line eslint/no-await-in-loop -- readiness poll
      await Bun.sleep(500);
    }
  }
  throw new Error("celld dev did not start serving in time");
};

const run = async () => {
  for (let round = 1; round <= ROUNDS; round += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- rounds run one after another on purpose
    const answers = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => post(call("smoke.work", i)))
    );
    const done = answers.filter((a) => a?.[0]?.result === "done").length;
    check(
      done === CONCURRENCY,
      `round ${round}: ${done}/${CONCURRENCY} concurrent async actions answered`
    );
  }

  const users = Array.from({ length: 30 }, (_, i) => `user${i}`);
  const seen = await Promise.all(
    users.map((user) => post(call("smoke.whoami"), { "x-user": user }))
  );
  const own = seen.filter((a, i) => a?.[0]?.result === users[i]).length;
  check(
    own === users.length,
    `${own}/${users.length} requests saw their own context`
  );

  const batch = await post(
    `[${call("smoke.ping", 1)},${call("smoke.stall", 2)}]`
  );
  const byId = new Map((batch ?? []).map((f) => [f.id, f]));
  check(
    byId.get(1)?.result === "pong" &&
      Boolean(byId.get(2)?.error?.message.includes("timed out")),
    "a batch keeps its fast result when another call times out"
  );

  const stalled = await post(call("smoke.stall"));
  check(
    Boolean(stalled?.[0]?.error?.message.includes("timed out")),
    "a stuck action answers with the timeout error"
  );

  const after = await Promise.all(
    [1, 2, 3].map((id) => post(call("smoke.ping", id)))
  );
  check(
    after.every((a) => a?.[0]?.result === "pong"),
    "the isolate still answers afterwards"
  );
};

/** Boot `celld dev` on one config, run every check, stop the node. */
const runConfig = async (config: string) => {
  currentConfig = config;
  console.log(`== ${config}`);
  rmSync(path.join(APP, ".celld"), { force: true, recursive: true });
  const celld = Bun.spawn(
    [
      process.env["CELLD_BIN"] ?? "celld",
      "dev",
      "--no-watch",
      "--port",
      String(PORT),
      path.join(APP, config),
    ],
    {
      env: { ...process.env, NO_COLOR: "1" },
      stderr: "inherit",
      stdout: "ignore",
    }
  );
  try {
    await waitReady();
    await run();
  } finally {
    celld.kill("SIGTERM");
    await celld.exited;
  }
};

const main = async () => {
  await bundle();
  for (const config of CONFIGS) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one node on the port at a time
    await runConfig(config);
  }
  if (failures.length > 0) {
    console.error(`celld smoke: ${failures.length} check(s) failed`);
    for (const failure of failures) {
      console.error(`  ${failure}`);
    }
    process.exit(1);
  }
  console.log("celld smoke: all checks passed");
};

await main();
