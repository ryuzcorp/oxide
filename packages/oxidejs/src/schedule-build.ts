import fs from "node:fs";
import path from "node:path";

import {
  extractCallInner,
  hasProp,
  readLiteralStringProp,
  readRefProp,
} from "./durable-scan";
import type { QueueModule } from "./queue-build";
import type { WorkflowModule } from "./workflow-build";

const IGNORE_DIRS = new Set(["node_modules", "dist", ".git", ".wrangler"]);

const SERVER_EXTS = [".ts", ".tsx", ".js", ".jsx"] as const;

const isServerFileName = function isServerFileName(name: string): boolean {
  return SERVER_EXTS.some((ext) => name.endsWith(`.server${ext}`));
};

const serverModuleKey = function serverModuleKey(absFile: string): string {
  return path.basename(absFile).replace(/\.server\.(?:[jt]sx?)$/iu, "");
};

const SCHEDULE_EXPORT_RE =
  /^\s*export\s+const\s+(?<exportName>[A-Za-z_$][\w$]*)\s*=\s*schedule\s*\(/gmu;

export type ScheduleTargetKind = "handle" | "queue" | "workflow";

export interface ScheduleExportDef {
  cron: string;
  exportName: string;
  name: string;
  /** Binding filled after resolveScheduleRefs (workflow / queue). */
  queueBinding: string;
  queueName: string;
  queueRef: string;
  target: ScheduleTargetKind;
  workflowBinding: string;
  workflowName: string;
  workflowRef: string;
}

export interface ScheduleModule {
  abs: string;
  exports: ScheduleExportDef[];
  key: string;
}

export const parseScheduleExports = function parseScheduleExports(
  source: string
): ScheduleExportDef[] {
  const out: ScheduleExportDef[] = [];
  for (const match of source.matchAll(SCHEDULE_EXPORT_RE)) {
    const exportName = match.groups?.["exportName"] ?? match[1];
    if (!(exportName && match.index !== undefined)) {
      continue;
    }
    const openParen = match.index + match[0].length - 1;
    const inner = extractCallInner(source, openParen) ?? "";
    const label = `schedule "${exportName}"`;
    const name = readLiteralStringProp(inner, "name", label) ?? exportName;
    const cron = readLiteralStringProp(inner, "cron", label);
    if (!cron) {
      throw new Error(
        `oxidejs: schedule "${exportName}" requires cron: (string literal expression)`
      );
    }
    const hasWorkflow = hasProp(inner, "workflow");
    const hasQueue = hasProp(inner, "queue");
    const hasHandle = hasProp(inner, "handle");
    const targets = Number(hasWorkflow) + Number(hasQueue) + Number(hasHandle);
    if (targets !== 1) {
      throw new Error(
        `oxidejs: schedule "${exportName}" requires exactly one of workflow, queue, or handle`
      );
    }
    let target: ScheduleTargetKind = "handle";
    let workflowRef = "";
    let queueRef = "";
    if (hasWorkflow) {
      target = "workflow";
      workflowRef = readRefProp(inner, "workflow", label) ?? "";
      if (!workflowRef) {
        throw new Error(
          `oxidejs: schedule "${exportName}" workflow: must be a handle identifier or name string`
        );
      }
    } else if (hasQueue) {
      target = "queue";
      queueRef = readRefProp(inner, "queue", label) ?? "";
      if (!queueRef) {
        throw new Error(
          `oxidejs: schedule "${exportName}" queue: must be a handle identifier or name string`
        );
      }
    }
    out.push({
      cron,
      exportName,
      name,
      queueBinding: "",
      queueName: "",
      queueRef,
      target,
      workflowBinding: "",
      workflowName: "",
      workflowRef,
    });
  }
  return out;
};

export const scanScheduleFiles = function scanScheduleFiles(
  root: string
): ScheduleModule[] {
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

  const byName = new Map<string, string>();
  const modules: ScheduleModule[] = [];
  // SAFETY: Bun provides Array.prototype.toSorted; package tsconfig targets ES2022 without its typings.
  const sortedFiles = (
    files as string[] & { toSorted: () => string[] }
  ).toSorted();
  for (const abs of sortedFiles) {
    const key = serverModuleKey(abs);
    if (!key) {
      throw new Error(`oxidejs: invalid schedule module name: ${abs}`);
    }
    const source = fs.readFileSync(abs, "utf-8");
    const exports = parseScheduleExports(source);
    if (exports.length === 0) {
      continue;
    }
    for (const exp of exports) {
      const prior = byName.get(exp.name);
      if (prior) {
        throw new Error(
          `oxidejs: duplicate schedule name "${exp.name}": ${prior} and ${abs}`
        );
      }
      byName.set(exp.name, abs);
    }
    modules.push({ abs, exports, key });
  }
  return modules;
};

/** Resolve workflow / queue refs on scanned schedules. */
export const resolveScheduleRefs = function resolveScheduleRefs(
  schedules: ScheduleModule[],
  workflows: WorkflowModule[],
  queues: QueueModule[]
) {
  const workflowsByExport = new Map<
    string,
    { binding: string; name: string }
  >();
  const workflowsByName = new Map<string, { binding: string; name: string }>();
  for (const mod of workflows) {
    for (const exp of mod.exports) {
      workflowsByExport.set(exp.exportName, {
        binding: exp.binding,
        name: exp.name,
      });
      workflowsByName.set(exp.name, { binding: exp.binding, name: exp.name });
    }
  }
  const queuesByExport = new Map<
    string,
    {
      binding: string;
      name: string;
      workflowBinding: string;
      workflowName: string;
    }
  >();
  const queuesByName = new Map<
    string,
    {
      binding: string;
      name: string;
      workflowBinding: string;
      workflowName: string;
    }
  >();
  for (const mod of queues) {
    for (const exp of mod.exports) {
      const hit = {
        binding: exp.binding,
        name: exp.name,
        workflowBinding: exp.workflowBinding,
        workflowName: exp.workflowName,
      };
      queuesByExport.set(exp.exportName, hit);
      queuesByName.set(exp.name, hit);
    }
  }

  for (const mod of schedules) {
    for (const exp of mod.exports) {
      if (exp.target === "workflow") {
        const hit =
          workflowsByExport.get(exp.workflowRef) ??
          workflowsByName.get(exp.workflowRef);
        if (!hit) {
          throw new Error(
            `oxidejs: schedule "${exp.name}" workflow "${exp.workflowRef}" not found — export workflow() with that name/export in a *.server.ts file`
          );
        }
        exp.workflowBinding = hit.binding;
        exp.workflowName = hit.name;
      }
      if (exp.target === "queue") {
        const hit =
          queuesByExport.get(exp.queueRef) ?? queuesByName.get(exp.queueRef);
        if (!hit) {
          throw new Error(
            `oxidejs: schedule "${exp.name}" queue "${exp.queueRef}" not found — export queue() with that name/export in a *.server.ts file`
          );
        }
        exp.queueBinding = hit.binding;
        exp.queueName = hit.name;
        exp.workflowBinding = hit.workflowBinding;
        exp.workflowName = hit.workflowName;
      }
    }
  }
};

export const assertScheduleCollisions = function assertScheduleCollisions(
  servers: { exports: readonly string[]; key: string }[],
  workflows: WorkflowModule[],
  queues: QueueModule[],
  schedules: ScheduleModule[]
) {
  const actionKeys = new Set(
    servers.filter((mod) => mod.exports.length > 0).map((mod) => mod.key)
  );
  const workflowNames = new Set(
    workflows.flatMap((mod) => mod.exports.map((exp) => exp.name))
  );
  const queueNames = new Set(
    queues.flatMap((mod) => mod.exports.map((exp) => exp.name))
  );
  for (const mod of schedules) {
    for (const exp of mod.exports) {
      if (actionKeys.has(exp.name)) {
        throw new Error(
          `oxidejs: schedule name "${exp.name}" collides with server module key "${exp.name}" that exports actions`
        );
      }
      if (workflowNames.has(exp.name)) {
        throw new Error(
          `oxidejs: schedule name "${exp.name}" collides with workflow name "${exp.name}"`
        );
      }
      if (queueNames.has(exp.name)) {
        throw new Error(
          `oxidejs: schedule name "${exp.name}" collides with queue name "${exp.name}"`
        );
      }
    }
  }
};

export const appendScheduleClientExports = function appendScheduleClientExports(
  lines: string[],
  exports: ScheduleExportDef[]
) {
  for (const exp of exports) {
    // Server-only trigger — client gets an empty marker.
    lines.push(`export const ${exp.exportName} = {};`);
  }
};

/** Virtual module: `handleSchedule(controller, env, ctx)`. */
export const generateScheduleHandlerModule =
  function generateScheduleHandlerModule(
    modules: ScheduleModule[],
    opts?: { bust?: boolean }
  ): string {
    if (modules.length === 0) {
      return `export async function handleSchedule() {\n  throw new Error("oxidejs: no schedules registered");\n}\n`;
    }
    const lines = [
      `import { dispatchSchedule, readScheduleMeta } from "oxidejs";`,
    ];
    const metaVars: string[] = [];
    for (const [i, mod] of modules.entries()) {
      const alias = `__s${i}`;
      const spec =
        opts?.bust === true
          ? `${mod.abs}?t=${fs.statSync(mod.abs).mtimeMs}`
          : mod.abs;
      lines.push(`import * as ${alias} from ${JSON.stringify(spec)};`);
      for (const exp of mod.exports) {
        const metaVar = `__smeta_${i}_${exp.exportName}`;
        lines.push(
          `const ${metaVar} = readScheduleMeta(${alias}[${JSON.stringify(exp.exportName)}]);`,
          `if (!${metaVar}) throw new Error(${JSON.stringify(`oxidejs: missing schedule meta for ${exp.exportName}`)});`
        );
        metaVars.push(metaVar);
      }
    }
    lines.push(
      `const __metas = [${metaVars.join(", ")}];`,
      `export async function handleSchedule(controller, env, ctx) {`,
      `  return dispatchSchedule(__metas, controller, env, ctx);`,
      `}`
    );
    return `${lines.join("\n")}\n`;
  };

export const scheduleWranglerCrons = function scheduleWranglerCrons(
  modules: ScheduleModule[]
): string[] {
  const crons = new Set<string>();
  for (const mod of modules) {
    for (const exp of mod.exports) {
      crons.add(exp.cron);
    }
  }
  // SAFETY: Bun provides Array.prototype.toSorted; package tsconfig targets ES2022 without its typings.
  return ([...crons] as string[] & { toSorted: () => string[] }).toSorted();
};
