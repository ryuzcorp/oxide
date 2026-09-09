import fs from "node:fs";
import path from "node:path";

import { extractCallInner, readLiteralStringProp } from "./durable-scan";
import { VIRTUAL_CLIENT_ID } from "./virtual-ids";
import { toWorkflowBinding, toWorkflowClassName } from "./workflow";

const IGNORE_DIRS = new Set(["node_modules", "dist", ".git", ".wrangler"]);

const SERVER_EXTS = [".ts", ".tsx", ".js", ".jsx"] as const;

const isServerFileName = function isServerFileName(name: string): boolean {
  return SERVER_EXTS.some((ext) => name.endsWith(`.server${ext}`));
};

const serverModuleKey = function serverModuleKey(absFile: string): string {
  return path.basename(absFile).replace(/\.server\.(?:[jt]sx?)$/iu, "");
};

const WORKFLOW_EXPORT_RE =
  /^\s*export\s+const\s+(?<exportName>[A-Za-z_$][\w$]*)\s*=\s*workflow\s*\(/gmu;

const LEGACY_WORKFLOW_EXT = [".ts", ".tsx", ".js", ".jsx"] as const;

/** Reject leftover `*.workflow.ts` files — workflows live in `*.server.ts` now. */
export const isLegacyWorkflowFileId = function isLegacyWorkflowFileId(
  id: string
): boolean {
  const file = id.split("?")[0]?.replaceAll("\\", "/") ?? "";
  return LEGACY_WORKFLOW_EXT.some((ext) => file.endsWith(`.workflow${ext}`));
};

export interface WorkflowExportDef {
  binding: string;
  className: string;
  exportName: string;
  /** Rpc + wrangler workflow name. */
  name: string;
}

export interface WorkflowModule {
  abs: string;
  exports: WorkflowExportDef[];
  key: string;
}

export const parseWorkflowExports = function parseWorkflowExports(
  source: string
): WorkflowExportDef[] {
  const out: WorkflowExportDef[] = [];
  for (const match of source.matchAll(WORKFLOW_EXPORT_RE)) {
    const exportName = match.groups?.["exportName"] ?? match[1];
    if (!(exportName && match.index !== undefined)) {
      continue;
    }
    const openParen = match.index + match[0].length - 1;
    const inner = extractCallInner(source, openParen) ?? "";
    const label = `workflow "${exportName}"`;
    const name = readLiteralStringProp(inner, "name", label) ?? exportName;
    const binding =
      readLiteralStringProp(inner, "binding", label) ?? toWorkflowBinding(name);
    const className =
      readLiteralStringProp(inner, "className", label) ??
      toWorkflowClassName(name);
    out.push({ binding, className, exportName, name });
  }
  return out;
};

/**
 * Scan `*.server.ts` for `export const x = workflow(...)`.
 * Files with no workflow exports are skipped.
 */
export const scanWorkflowFiles = function scanWorkflowFiles(
  root: string
): WorkflowModule[] {
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
      if (isLegacyWorkflowFileId(entry.name)) {
        throw new Error(
          `oxidejs: ${abs} uses *.workflow.ts — export workflow() from a *.server.ts file instead`
        );
      }
      if (isServerFileName(entry.name)) {
        files.push(abs);
      }
    }
  };
  walk(root);

  const byExport = new Map<string, string>();
  const byBinding = new Map<string, string>();
  const byClass = new Map<string, string>();
  const modules: WorkflowModule[] = [];
  // SAFETY: Bun provides Array.prototype.toSorted; package tsconfig targets ES2022 without its typings.
  const sortedFiles = (
    files as string[] & { toSorted: () => string[] }
  ).toSorted();
  for (const abs of sortedFiles) {
    const key = serverModuleKey(abs);
    if (!key) {
      throw new Error(`oxidejs: invalid workflow module name: ${abs}`);
    }
    const source = fs.readFileSync(abs, "utf-8");
    const exports = parseWorkflowExports(source);
    if (exports.length === 0) {
      continue;
    }
    for (const exp of exports) {
      const priorExport = byExport.get(exp.name);
      if (priorExport) {
        throw new Error(
          `oxidejs: duplicate workflow name "${exp.name}": ${priorExport} and ${abs}`
        );
      }
      byExport.set(exp.name, abs);
      const priorBinding = byBinding.get(exp.binding);
      if (priorBinding) {
        throw new Error(
          `oxidejs: duplicate workflow binding "${exp.binding}": ${priorBinding} and ${abs}`
        );
      }
      byBinding.set(exp.binding, abs);
      const priorClass = byClass.get(exp.className);
      if (priorClass) {
        throw new Error(
          `oxidejs: duplicate workflow className "${exp.className}": ${priorClass} and ${abs}`
        );
      }
      byClass.set(exp.className, abs);
    }
    modules.push({ abs, exports, key });
  }
  return modules;
};

/**
 * Workflow Rpc prefix (`name.start`) must not share a client namespace with a
 * `*.server.ts` module key that also exports `action()`s.
 */
export const assertWorkflowActionCollisions =
  function assertWorkflowActionCollisions(
    servers: { exports: readonly string[]; key: string }[],
    workflows: WorkflowModule[]
  ) {
    const actionKeys = new Set(
      servers.filter((mod) => mod.exports.length > 0).map((mod) => mod.key)
    );
    for (const mod of workflows) {
      for (const exp of mod.exports) {
        if (actionKeys.has(exp.name)) {
          throw new Error(
            `oxidejs: workflow name "${exp.name}" collides with server module key "${exp.name}" that exports actions — rename the workflow \`name\` or the *.server.ts file`
          );
        }
      }
    }
  };

const workflowStubExport = function workflowStubExport(exp: WorkflowExportDef) {
  const base = `client[${JSON.stringify(exp.name)}]`;
  const peel = (method: string) => `(...args) => {
  const opts = args.at(-1);
  const isOpts = opts && typeof opts === "object" && !Array.isArray(opts) &&
    (() => {
      const keys = Object.keys(opts);
      if (keys.length === 0 || keys.length > 2) return false;
      for (const key of keys) if (key !== "signal" && key !== "idempotencyKey") return false;
      if ("signal" in opts && !(opts.signal instanceof AbortSignal)) return false;
      if ("idempotencyKey" in opts && opts.idempotencyKey !== undefined && typeof opts.idempotencyKey !== "string") return false;
      return "signal" in opts || "idempotencyKey" in opts;
    })();
  return isOpts
    ? ${base}[${JSON.stringify(method)}](...args.slice(0, -1), opts)
    : ${base}[${JSON.stringify(method)}](...args);
}`;
  return [
    `export const ${exp.exportName} = {`,
    `  start: wrapClientRpc(${peel("start")}),`,
    `  status: wrapClientRpc(${peel("status")}),`,
    `  send: wrapClientRpc(${peel("send")}),`,
    `};`,
  ].join("\n");
};

/** Client stub fragment for `workflow()` exports (used inside `*.server.ts` stubs). */
export const generateWorkflowClientStub = function generateWorkflowClientStub(
  mod: Pick<WorkflowModule, "exports">
): string {
  if (mod.exports.length === 0) {
    return `export {};\n`;
  }
  const lines = [
    `// oxidejs:workflow-stub`,
    `import { wrapClientRpc } from "oxidejs";`,
    `import { client } from ${JSON.stringify(VIRTUAL_CLIENT_ID)};`,
  ];
  for (const exp of mod.exports) {
    lines.push(workflowStubExport(exp));
  }
  return `${lines.join("\n")}\n`;
};

export const appendWorkflowClientExports = function appendWorkflowClientExports(
  lines: string[],
  exports: WorkflowExportDef[]
) {
  for (const exp of exports) {
    lines.push(workflowStubExport(exp));
  }
};

export const generateWorkflowClassesModule =
  function generateWorkflowClassesModule(
    modules: WorkflowModule[],
    opts?: { bust?: boolean }
  ): string {
    if (modules.length === 0) {
      return `export {};\n`;
    }
    const lines = [
      `import { WorkflowEntrypoint } from "cloudflare:workers";`,
      `import { readWorkflowMeta } from "oxidejs";`,
    ];
    for (const [i, mod] of modules.entries()) {
      const alias = `__w${i}`;
      const spec =
        opts?.bust === true
          ? `${mod.abs}?t=${fs.statSync(mod.abs).mtimeMs}`
          : mod.abs;
      lines.push(`import * as ${alias} from ${JSON.stringify(spec)};`);
      for (const exp of mod.exports) {
        lines.push(
          `const __meta_${exp.className} = readWorkflowMeta(${alias}[${JSON.stringify(exp.exportName)}]);`,
          `if (!__meta_${exp.className}) throw new Error(${JSON.stringify(`oxidejs: missing workflow meta for ${exp.exportName}`)});`,
          `export class ${exp.className} extends WorkflowEntrypoint {`,
          `  async run(event, step) {`,
          `    return __meta_${exp.className}.run(event, step);`,
          `  }`,
          `}`
        );
      }
    }
    return `${lines.join("\n")}\n`;
  };

export const workflowWranglerEntries = function workflowWranglerEntries(
  modules: WorkflowModule[]
) {
  return modules.flatMap((mod) =>
    mod.exports.map((exp) => ({
      binding: exp.binding,
      class_name: exp.className,
      name: exp.name,
    }))
  );
};
