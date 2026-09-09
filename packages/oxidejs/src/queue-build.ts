import fs from "node:fs";
import path from "node:path";

import {
  extractCallInner,
  readLiteralStringProp,
  readNumberProp,
  readRefProp,
} from "./durable-scan";
import { toQueueBinding } from "./queue";
import { VIRTUAL_CLIENT_ID } from "./virtual-ids";
import type { WorkflowModule } from "./workflow-build";

const IGNORE_DIRS = new Set(["node_modules", "dist", ".git", ".wrangler"]);

const SERVER_EXTS = [".ts", ".tsx", ".js", ".jsx"] as const;

const isServerFileName = function isServerFileName(name: string): boolean {
  return SERVER_EXTS.some((ext) => name.endsWith(`.server${ext}`));
};

const serverModuleKey = function serverModuleKey(absFile: string): string {
  return path.basename(absFile).replace(/\.server\.(?:[jt]sx?)$/iu, "");
};

const QUEUE_EXPORT_RE =
  /^\s*export\s+const\s+(?<exportName>[A-Za-z_$][\w$]*)\s*=\s*queue\s*\(/gmu;

export interface QueueExportDef {
  binding: string;
  exportName: string;
  maxBatchSize?: number;
  maxBatchTimeout?: number;
  maxRetries?: number;
  /** Rpc + wrangler queue name. */
  name: string;
  /** Resolved workflow env binding (after `resolveQueueWorkflowRefs`). */
  workflowBinding: string;
  /** `workflow:` prop — handle export name or workflow `name` string. */
  workflowRef: string;
  /** Resolved workflow wrangler `name` (after resolve). */
  workflowName: string;
}

export interface QueueModule {
  abs: string;
  exports: QueueExportDef[];
  key: string;
}

export const parseQueueExports = function parseQueueExports(
  source: string
): QueueExportDef[] {
  const out: QueueExportDef[] = [];
  for (const match of source.matchAll(QUEUE_EXPORT_RE)) {
    const exportName = match.groups?.["exportName"] ?? match[1];
    if (!(exportName && match.index !== undefined)) {
      continue;
    }
    const openParen = match.index + match[0].length - 1;
    const inner = extractCallInner(source, openParen) ?? "";
    const label = `queue "${exportName}"`;
    const name = readLiteralStringProp(inner, "name", label) ?? exportName;
    const binding =
      readLiteralStringProp(inner, "binding", label) ?? toQueueBinding(name);
    const workflowRef = readRefProp(inner, "workflow", label);
    if (!workflowRef) {
      throw new Error(
        `oxidejs: queue "${exportName}" requires workflow: (handle identifier or name string)`
      );
    }
    const maxBatchSize = readNumberProp(inner, "maxBatchSize");
    const maxBatchTimeout = readNumberProp(inner, "maxBatchTimeout");
    const maxRetries = readNumberProp(inner, "maxRetries");
    const exp: QueueExportDef = {
      binding,
      exportName,
      name,
      // Filled by resolveQueueWorkflowRefs.
      workflowBinding: "",
      workflowName: "",
      workflowRef,
    };
    if (maxBatchSize !== undefined) {
      exp.maxBatchSize = maxBatchSize;
    }
    if (maxBatchTimeout !== undefined) {
      exp.maxBatchTimeout = maxBatchTimeout;
    }
    if (maxRetries !== undefined) {
      exp.maxRetries = maxRetries;
    }
    out.push(exp);
  }
  return out;
};

/**
 * Scan `*.server.ts` for `export const x = queue(...)`.
 * Files with no queue exports are skipped. Call `resolveQueueWorkflowRefs`
 * after scanning workflows.
 */
export const scanQueueFiles = function scanQueueFiles(
  root: string
): QueueModule[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) {
          continue;
        }
        walk(abs);
        continue;
      }
      if (!(entry.isFile() && entry.name)) {
        continue;
      }
      if (isServerFileName(entry.name)) {
        files.push(abs);
      }
    }
  };
  walk(root);

  const byExport = new Map<string, string>();
  const byBinding = new Map<string, string>();
  const modules: QueueModule[] = [];
  // SAFETY: Bun provides Array.prototype.toSorted; package tsconfig targets ES2022 without its typings.
  const sortedFiles = (
    files as string[] & { toSorted: () => string[] }
  ).toSorted();
  for (const abs of sortedFiles) {
    const key = serverModuleKey(abs);
    if (!key) {
      throw new Error(`oxidejs: invalid queue module name: ${abs}`);
    }
    const source = fs.readFileSync(abs, "utf-8");
    const exports = parseQueueExports(source);
    if (exports.length === 0) {
      continue;
    }
    for (const exp of exports) {
      const priorExport = byExport.get(exp.name);
      if (priorExport) {
        throw new Error(
          `oxidejs: duplicate queue name "${exp.name}": ${priorExport} and ${abs}`
        );
      }
      byExport.set(exp.name, abs);
      const priorBinding = byBinding.get(exp.binding);
      if (priorBinding) {
        throw new Error(
          `oxidejs: duplicate queue binding "${exp.binding}": ${priorBinding} and ${abs}`
        );
      }
      byBinding.set(exp.binding, abs);
    }
    modules.push({ abs, exports, key });
  }
  return modules;
};

/** Resolve `workflow:` refs to workflow name + binding; reject unknown refs. */
export const resolveQueueWorkflowRefs = function resolveQueueWorkflowRefs(
  queues: QueueModule[],
  workflows: WorkflowModule[]
) {
  const byExportName = new Map<string, { binding: string; name: string }>();
  const byName = new Map<string, { binding: string; name: string }>();
  for (const mod of workflows) {
    for (const exp of mod.exports) {
      byExportName.set(exp.exportName, {
        binding: exp.binding,
        name: exp.name,
      });
      byName.set(exp.name, { binding: exp.binding, name: exp.name });
    }
  }
  for (const mod of queues) {
    for (const exp of mod.exports) {
      const hit =
        byExportName.get(exp.workflowRef) ?? byName.get(exp.workflowRef);
      if (!hit) {
        throw new Error(
          `oxidejs: queue "${exp.name}" workflow "${exp.workflowRef}" not found — export workflow() with that name/export in a *.server.ts file`
        );
      }
      exp.workflowBinding = hit.binding;
      exp.workflowName = hit.name;
    }
  }
};

/**
 * Queue Rpc prefix (`name.send`) must not share a client namespace with a
 * `*.server.ts` module key that exports `action()`s, or a workflow `name`.
 */
export const assertQueueCollisions = function assertQueueCollisions(
  servers: { exports: readonly string[]; key: string }[],
  workflows: WorkflowModule[],
  queues: QueueModule[]
) {
  const actionKeys = new Set(
    servers.filter((mod) => mod.exports.length > 0).map((mod) => mod.key)
  );
  const workflowNames = new Set(
    workflows.flatMap((mod) => mod.exports.map((exp) => exp.name))
  );
  for (const mod of queues) {
    for (const exp of mod.exports) {
      if (actionKeys.has(exp.name)) {
        throw new Error(
          `oxidejs: queue name "${exp.name}" collides with server module key "${exp.name}" that exports actions — rename the queue \`name\` or the *.server.ts file`
        );
      }
      if (workflowNames.has(exp.name)) {
        throw new Error(
          `oxidejs: queue name "${exp.name}" collides with workflow name "${exp.name}" — Rpc tags would overlap (e.g. ${exp.name}.send)`
        );
      }
    }
  }
};

const queueStubExport = function queueStubExport(exp: QueueExportDef) {
  const base = `client[${JSON.stringify(exp.name)}]`;
  const peel = (method: string) => `(...args) => {
  const opts = args.at(-1);
  const isOpts = opts && typeof opts === "object" && !Array.isArray(opts) &&
    (() => {
      const keys = Object.keys(opts);
      if (keys.length === 0 || keys.length > 4) return false;
      for (const key of keys) {
        if (key !== "signal" && key !== "idempotencyKey" && key !== "contentType" && key !== "delaySeconds") return false;
      }
      if ("signal" in opts && !(opts.signal instanceof AbortSignal)) return false;
      if ("idempotencyKey" in opts && opts.idempotencyKey !== undefined && typeof opts.idempotencyKey !== "string") return false;
      if ("contentType" in opts && opts.contentType !== undefined && typeof opts.contentType !== "string") return false;
      if ("delaySeconds" in opts && opts.delaySeconds !== undefined && typeof opts.delaySeconds !== "number") return false;
      return "signal" in opts || "idempotencyKey" in opts || "contentType" in opts || "delaySeconds" in opts;
    })();
  if (!isOpts) {
    return ${base}[${JSON.stringify(method)}](...args);
  }
  const params = args.slice(0, -1);
  const callOpts = {};
  const sendOpts = {};
  if ("signal" in opts) callOpts.signal = opts.signal;
  if ("idempotencyKey" in opts) callOpts.idempotencyKey = opts.idempotencyKey;
  if ("contentType" in opts) sendOpts.contentType = opts.contentType;
  if ("delaySeconds" in opts) sendOpts.delaySeconds = opts.delaySeconds;
  const hasCall = Object.keys(callOpts).length > 0;
  const hasSend = Object.keys(sendOpts).length > 0;
  if (hasSend && hasCall) {
    return ${base}[${JSON.stringify(method)}](...params, sendOpts, callOpts);
  }
  if (hasSend) {
    return ${base}[${JSON.stringify(method)}](...params, sendOpts);
  }
  if (hasCall) {
    return ${base}[${JSON.stringify(method)}](...params, callOpts);
  }
  return ${base}[${JSON.stringify(method)}](...params);
}`;
  return [
    `export const ${exp.exportName} = {`,
    `  send: wrapClientRpc(${peel("send")}),`,
    `  sendBatch: wrapClientRpc(${peel("sendBatch")}),`,
    `};`,
  ].join("\n");
};

/** Client stub fragment for `queue()` exports (used inside `*.server.ts` stubs). */
export const generateQueueClientStub = function generateQueueClientStub(
  mod: Pick<QueueModule, "exports">
): string {
  if (mod.exports.length === 0) {
    return `export {};\n`;
  }
  const lines = [
    `// oxidejs:queue-stub`,
    `import { wrapClientRpc } from "oxidejs";`,
    `import { client } from ${JSON.stringify(VIRTUAL_CLIENT_ID)};`,
  ];
  for (const exp of mod.exports) {
    lines.push(queueStubExport(exp));
  }
  return `${lines.join("\n")}\n`;
};

export const appendQueueClientExports = function appendQueueClientExports(
  lines: string[],
  exports: QueueExportDef[]
) {
  for (const exp of exports) {
    lines.push(queueStubExport(exp));
  }
};

/** Virtual module: `handleQueue(batch, env, ctx)` for the worker `queue` handler. */
export const generateQueueHandlerModule = function generateQueueHandlerModule(
  modules: QueueModule[],
  opts?: { bust?: boolean }
): string {
  if (modules.length === 0) {
    return `export async function handleQueue() {\n  throw new Error("oxidejs: no queues registered");\n}\n`;
  }
  const lines = [
    `import { dispatchQueueBatch, readQueueMeta } from "oxidejs";`,
  ];
  const entries: string[] = [];
  for (const [i, mod] of modules.entries()) {
    const alias = `__q${i}`;
    const spec =
      opts?.bust === true
        ? `${mod.abs}?t=${fs.statSync(mod.abs).mtimeMs}`
        : mod.abs;
    lines.push(`import * as ${alias} from ${JSON.stringify(spec)};`);
    for (const exp of mod.exports) {
      const metaVar = `__qmeta_${i}_${exp.exportName}`;
      lines.push(
        `const ${metaVar} = readQueueMeta(${alias}[${JSON.stringify(exp.exportName)}]);`,
        `if (!${metaVar}) throw new Error(${JSON.stringify(`oxidejs: missing queue meta for ${exp.exportName}`)});`
      );
      entries.push(`${JSON.stringify(exp.name)}: ${metaVar}`);
    }
  }
  lines.push(
    `const __handlers = { ${entries.join(", ")} };`,
    `export async function handleQueue(batch, env, ctx) {`,
    `  const meta = __handlers[batch.queue];`,
    `  if (!meta) {`,
    `    throw new Error("oxidejs: no queue handler for " + batch.queue);`,
    `  }`,
    `  return dispatchQueueBatch(meta, batch, env, ctx);`,
    `}`
  );
  return `${lines.join("\n")}\n`;
};

export const queueWranglerEntries = function queueWranglerEntries(
  modules: QueueModule[]
) {
  const producers: { binding: string; queue: string }[] = [];
  const consumers: {
    max_batch_size?: number;
    max_batch_timeout?: number;
    max_retries?: number;
    queue: string;
  }[] = [];
  for (const mod of modules) {
    for (const exp of mod.exports) {
      producers.push({ binding: exp.binding, queue: exp.name });
      const consumer: (typeof consumers)[number] = { queue: exp.name };
      if (exp.maxBatchSize !== undefined) {
        consumer.max_batch_size = exp.maxBatchSize;
      }
      if (exp.maxBatchTimeout !== undefined) {
        consumer.max_batch_timeout = exp.maxBatchTimeout;
      }
      if (exp.maxRetries !== undefined) {
        consumer.max_retries = exp.maxRetries;
      }
      consumers.push(consumer);
    }
  }
  return { consumers, producers };
};
