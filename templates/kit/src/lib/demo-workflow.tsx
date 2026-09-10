import { atom } from "ilha";

import { demo, demos } from "./demo.server";

/** Start / poll the kit `demo` Cloudflare Workflow (direct or via queue). */
export const DemoWorkflowPanel = () => {
  const id = atom<string | null>(null);
  const status = atom("idle");
  const output = atom("");
  const busy = atom(false);
  const err = atom("");
  const queuedNote = atom("");

  const refresh = async () => {
    const current = id();
    if (!current) {
      return;
    }
    busy.set(true);
    err.set("");
    try {
      const next = await demo.status(current);
      status.set(next.status);
      output.set(
        next.output === undefined || next.output === null
          ? ""
          : JSON.stringify(next.output, null, 2)
      );
      if (next.error?.message) {
        err.set(next.error.message);
      } else {
        err.set("");
      }
    } catch (error) {
      err.set(error instanceof Error ? error.message : String(error));
    } finally {
      busy.set(false);
    }
  };

  /** Poll until the instance exists (queue consumer may lag behind send). */
  const pollUntilReady = async (attempt = 0): Promise<void> => {
    await refresh();
    if (status() !== "not_found") {
      return;
    }
    if (attempt >= 19) {
      queuedNote.set(
        "Still not_found after polling — workflow create may have failed."
      );
      return;
    }
    // oxlint-disable-next-line promise/avoid-new -- browser-safe delay between polls
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 400);
    });
    return pollUntilReady(attempt + 1);
  };

  const start = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }
    const message = String(new FormData(form).get("message") ?? "").trim();
    if (!message) {
      return;
    }
    busy.set(true);
    err.set("");
    output.set("");
    queuedNote.set("");
    try {
      const started = await demo.start({ message });
      id.set(started.id);
      status.set("queued");
      form.reset();
      await refresh();
    } catch (error) {
      err.set(error instanceof Error ? error.message : String(error));
    } finally {
      busy.set(false);
    }
  };

  const enqueue = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }
    const message = String(new FormData(form).get("message") ?? "").trim();
    if (!message) {
      return;
    }
    busy.set(true);
    err.set("");
    output.set("");
    queuedNote.set("");
    try {
      const { id: startedId } = await demos.send({ message });
      id.set(startedId);
      status.set("queued");
      queuedNote.set("Enqueued — workflow started from send (celld + CF).");
      form.reset();
      await pollUntilReady();
    } catch (error) {
      err.set(error instanceof Error ? error.message : String(error));
    } finally {
      busy.set(false);
    }
  };

  return (
    <div class="flex flex-col gap-3">
      <h2 class="card-title m-0">Workflow + queue demo</h2>
      <p class="text-sm opacity-70">
        Start a workflow directly, or enqueue via <code>demos</code> (producer
        starts the same workflow; CF also runs the queue consumer). Poll status
        until complete.
      </p>
      <form onsubmit={start} class="flex items-center gap-2">
        <input
          name="message"
          class="input input-bordered w-full"
          placeholder="hello workflow"
          disabled={busy()}
        />
        <button type="submit" class="btn btn-secondary" disabled={busy()}>
          Start
        </button>
      </form>
      <form onsubmit={enqueue} class="flex items-center gap-2">
        <input
          name="message"
          class="input input-bordered w-full"
          placeholder="hello queue"
          disabled={busy()}
        />
        <button type="submit" class="btn btn-outline" disabled={busy()}>
          Enqueue
        </button>
      </form>
      {queuedNote() ? <p class="text-sm opacity-70">{queuedNote()}</p> : null}
      {id() ? (
        <div class="flex flex-col gap-2 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge badge-outline">{status()}</span>
            <code class="opacity-70">{id()}</code>
            <button
              type="button"
              class="btn btn-xs"
              disabled={busy()}
              onclick={async () => {
                await refresh();
              }}
            >
              Refresh
            </button>
          </div>
          {err() ? <p class="text-error">{err()}</p> : null}
          {output() ? (
            <pre class="bg-base-200 overflow-x-auto rounded p-3 text-xs">
              {output()}
            </pre>
          ) : null}
        </div>
      ) : null}
      {!id() && err() ? <p class="text-error text-sm">{err()}</p> : null}
    </div>
  );
};
