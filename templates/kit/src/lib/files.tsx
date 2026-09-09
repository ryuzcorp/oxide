import { atom, watch } from "ilha";

import { listFiles, removeFile } from "./files.server";
import type { StoredFile } from "./files.server";

const formatSize = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Upload / list / delete objects in the kit R2 `FILES` bucket. */
export const FilesPanel = () => {
  const files = atom<StoredFile[]>([]);
  const busy = atom(false);
  const errorMessage = atom("");

  const load = async () => {
    busy.set(true);
    errorMessage.set("");
    try {
      files.set(await listFiles());
    } catch (error) {
      errorMessage.set(error instanceof Error ? error.message : String(error));
    } finally {
      busy.set(false);
    }
  };

  const upload = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }
    const input = form.elements.namedItem("file");
    if (!(input instanceof HTMLInputElement) || !input.files?.length) {
      return;
    }
    busy.set(true);
    errorMessage.set("");
    try {
      const body = new FormData(form);
      const response = await fetch("/api/files", {
        body,
        credentials: "include",
        method: "POST",
      });
      if (!response.ok) {
        throw new Error((await response.text()) || response.statusText);
      }
      form.reset();
      await load();
    } catch (error) {
      errorMessage.set(error instanceof Error ? error.message : String(error));
      busy.set(false);
    }
  };

  const remove = async (key: string) => {
    busy.set(true);
    errorMessage.set("");
    try {
      await removeFile(key);
      await load();
    } catch (error) {
      errorMessage.set(error instanceof Error ? error.message : String(error));
      busy.set(false);
    }
  };

  watch.once(() => {
    load();
  });

  const items = files();

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-2">
        <h2 class="card-title m-0">Files (R2)</h2>
        <button
          type="button"
          class="btn btn-ghost btn-xs"
          disabled={busy()}
          onclick={() => {
            load();
          }}
        >
          Refresh
        </button>
      </div>
      <p class="text-sm opacity-70">
        Multipart upload hits <code>/api/files</code>; list and delete use
        unstorage over binding <code>FILES</code>.
      </p>
      <form onsubmit={upload} class="flex flex-wrap items-center gap-2">
        <input
          name="file"
          type="file"
          class="file-input file-input-bordered w-full max-w-xs"
          disabled={busy()}
          required
        />
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy()}>
          Upload
        </button>
      </form>
      {errorMessage() ? (
        <p class="text-error text-sm">{errorMessage()}</p>
      ) : null}
      <ul class="flex flex-col gap-2">
        {items.length > 0 ? (
          items.map((file) => (
            <li
              key={file.key}
              class="flex items-center justify-between gap-2 text-sm"
            >
              <div class="min-w-0">
                <p class="truncate font-medium">{file.name}</p>
                <p class="opacity-60">
                  {formatSize(file.size)} · {file.uploaded}
                </p>
              </div>
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                disabled={busy()}
                onclick={() => {
                  remove(file.key);
                }}
              >
                Delete
              </button>
            </li>
          ))
        ) : (
          <li class="opacity-70">No files yet.</li>
        )}
      </ul>
    </div>
  );
};
