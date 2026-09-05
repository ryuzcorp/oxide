import fs from "node:fs";
import path from "node:path";

import { generateActionsModule, scanServerFiles } from "../actions";

const RPC_MODULE = path.join(import.meta.dir, "index.ts");
const OXIDE_RUNTIME = path.join(import.meta.dir, "../context.ts");

export const writeGeneratedActions = function writeGeneratedActions(
  root: string
) {
  const out = path.join(root, "actions.mjs");
  fs.writeFileSync(
    out,
    generateActionsModule(scanServerFiles(root))
      .replaceAll("oxidejs/rpc", RPC_MODULE)
      .replaceAll('from "oxidejs"', `from ${JSON.stringify(OXIDE_RUNTIME)}`)
  );
  return out;
};

export const waitUntil = async function waitUntil(
  predicate: () => boolean,
  remainingMs: number
): Promise<void> {
  if (predicate() || remainingMs <= 0) {
    return;
  }
  await Bun.sleep(5);
  await waitUntil(predicate, remainingMs - 5);
};
