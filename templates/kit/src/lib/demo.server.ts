import { Schema } from "effect";
import { queue, schedule, workflow } from "oxidejs";

const Params = Schema.Struct({
  message: Schema.String,
});

/**
 * Tiny durable job so you can exercise Cloudflare Workflows locally:
 * start → sleep → finish, then poll status.
 */
export const demo = workflow({
  name: "demo",
  payload: Params,
  run: async ({ payload }, { step }) => {
    const normalized = await step.do("normalize", () =>
      payload.message.trim().toUpperCase()
    );
    await step.sleep("pause", "3 seconds");
    return await step.do("done", () => ({
      echo: normalized,
      ok: true as const,
    }));
  },
});

/**
 * Queue → workflow: each message starts `demo`.
 * Set `producerStart: true` for celld (same-worker consumers do not run with
 * `fetch`). On Cloudflare leave it off so queue semantics control execution.
 */
export const demos = queue({
  name: "demos",
  producerStart: true,
  workflow: demo,
});

/**
 * Hourly cron → starts `demo` with id `demo-hourly-<scheduledTime>`.
 */
export const demoHourly = schedule({
  cron: "0 * * * *",
  name: "demo-hourly",
  params: { message: "hourly" },
  workflow: demo,
});
