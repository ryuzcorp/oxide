import fs from "node:fs";
import path from "node:path";

import {
  generateActionsClientModule,
  generateActionsModule,
  scanServerFiles,
} from "../actions";

const RPC_MODULE = path.join(import.meta.dir, "index.ts");
const OXIDE_RUNTIME = path.join(import.meta.dir, "../context.ts");

export interface WriteGeneratedActionsOptions {
  code?: string;
  oxideRuntime?: string;
  rpcModule?: string;
}

export const writeGeneratedActions = function writeGeneratedActions(
  root: string,
  opts: WriteGeneratedActionsOptions = {}
) {
  const out = path.join(root, "actions.mjs");
  const source = opts.code ?? generateActionsModule(scanServerFiles(root));
  const rpcModule = opts.rpcModule ?? RPC_MODULE;
  const oxideRuntime = opts.oxideRuntime ?? OXIDE_RUNTIME;
  fs.writeFileSync(
    out,
    source
      .replaceAll("oxidejs/rpc", rpcModule)
      .replaceAll('from "oxidejs"', `from ${JSON.stringify(oxideRuntime)}`)
  );
  return out;
};

/**
 * Browser stub module: schema-blind RpcGroup the production client bundle
 * decodes with. Tests that assert client-visible errors must create their
 * client from this, not the server module (whose declared error schemas only
 * the server encodes with).
 */
export const writeGeneratedClient = function writeGeneratedClient(
  root: string
) {
  const out = path.join(root, "client.mjs");
  fs.writeFileSync(out, generateActionsClientModule(scanServerFiles(root)));
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
