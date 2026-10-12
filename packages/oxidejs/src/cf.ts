import { bindings, exports, triggers } from "@cloudflare/config";
import type { WorkerConfig } from "@cloudflare/config";

import { resolveQueueWorkflowRefs, scanQueueFiles } from "./queue-build";
import {
  resolveScheduleRefs,
  scanScheduleFiles,
  scheduleWranglerCrons,
} from "./schedule-build";
import { scanWorkflowFiles } from "./workflow-build";

type DurableEnv = NonNullable<WorkerConfig["env"]>;
type DurableExports = NonNullable<WorkerConfig["exports"]>;
type DurableTriggers = NonNullable<WorkerConfig["triggers"]>;

/** `cloudflare.config.ts` fragments from `oxideDurable`. */
export interface OxideDurableFragments {
  env: DurableEnv;
  exports: DurableExports;
  triggers: DurableTriggers;
}

interface QueueConsumerInput {
  maxBatchSize?: number;
  maxBatchTimeout?: number;
  maxRetries?: number;
  name: string;
}

/**
 * Scanned `workflow()` / `queue()` / `schedule()` bindings as
 * `cloudflare.config.ts` fragments (`{ env, exports, triggers }`) for
 * `defineWorker`. Spread them into the worker config:
 *
 * ```ts
 * import { oxideDurable } from "oxidejs/cf";
 *
 * const durable = oxideDurable(import.meta.dirname);
 * const worker = defineWorker({
 *   env: { DB: bindings.d1({ name: "kit" }), ...durable.env },
 *   exports: { ...durable.exports },
 *   triggers: [...durable.triggers],
 *   // …
 * });
 * ```
 *
 * This is the `mergeDurableBindings` equivalent for the `cf` CLI
 * build-output flow (`CLOUDFLARE_VITE_FORCE_BUILD_OUTPUT`), where
 * `@cloudflare/vite-plugin` loads `cloudflare.config.ts` itself and rejects
 * any `config` customizer — so `withOxide()` cannot merge there. Plain
 * `vite dev` / `vite build` keep merging through `withOxide()`.
 */
export const oxideDurable = function oxideDurable(
  root: string = process.cwd()
): OxideDurableFragments {
  const scannedWorkflows = scanWorkflowFiles(root);
  const scannedQueues = scanQueueFiles(root);
  resolveQueueWorkflowRefs(scannedQueues, scannedWorkflows);
  const scannedSchedules = scanScheduleFiles(root);
  resolveScheduleRefs(scannedSchedules, scannedWorkflows, scannedQueues);
  // SAFETY: the scanners reject duplicate names/bindings up front, so plain
  // assignment below matches mergeDurableBindings (last-wins by binding).
  const env: DurableEnv = {};
  for (const mod of scannedQueues) {
    for (const exp of mod.exports) {
      env[exp.binding] = bindings.queue({ name: exp.name });
    }
  }
  const workerExports: DurableExports = {};
  for (const mod of scannedWorkflows) {
    for (const exp of mod.exports) {
      workerExports[exp.className] = exports.workflow({ name: exp.name });
    }
  }
  const triggerList: DurableTriggers = [];
  for (const mod of scannedQueues) {
    for (const exp of mod.exports) {
      const consumer: QueueConsumerInput = { name: exp.name };
      if (exp.maxBatchSize !== undefined) {
        consumer.maxBatchSize = exp.maxBatchSize;
      }
      if (exp.maxBatchTimeout !== undefined) {
        consumer.maxBatchTimeout = exp.maxBatchTimeout;
      }
      if (exp.maxRetries !== undefined) {
        consumer.maxRetries = exp.maxRetries;
      }
      triggerList.push(triggers.queue(consumer));
    }
  }
  for (const cron of scheduleWranglerCrons(scannedSchedules)) {
    triggerList.push(triggers.scheduled({ schedule: cron }));
  }
  return { env, exports: workerExports, triggers: triggerList };
};
