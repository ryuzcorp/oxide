/* eslint-disable anti-slop/no-runtime-typeof -- unstorage meta is an untyped bag at the R2 boundary */
/* eslint-disable func-names -- Effect.gen uses anonymous generators (AGENTS.md) */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { action, useEnv, withSchema } from "oxidejs";

import { MissingAuthSecretError, requireUser, UnauthorizedError } from "./auth";
import {
  displayNameFor,
  filesStorage,
  ownsFileKey,
  userFilesBase,
} from "./files-storage";

const FileKey = Schema.String;

export interface StoredFile {
  key: string;
  name: string;
  size: number;
  uploaded: string;
}

const metaUploaded = (mtime: Date | string | undefined): string => {
  if (mtime instanceof Date) {
    return mtime.toISOString();
  }
  if (typeof mtime === "string") {
    return mtime;
  }
  return "";
};

/** List objects under the signed-in user's R2 prefix (unstorage). */
export const listFiles = action(
  () =>
    Effect.gen(function* () {
      const user = yield* requireUser;
      const storage = filesStorage(useEnv<KitEnv>()?.FILES);
      const base = userFilesBase(user.id);
      const keys = yield* Effect.tryPromise({
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
        try: () => storage.getKeys(base),
      });
      const files = yield* Effect.tryPromise({
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
        try: async () => {
          const rows = await Promise.all(
            keys
              .filter((key) => ownsFileKey(user.id, key))
              .map(async (key) => {
                const meta = await storage.getMeta(key);
                const size =
                  typeof meta?.["size"] === "number" ? meta["size"] : 0;
                return {
                  key,
                  name: displayNameFor(user.id, key),
                  size,
                  uploaded: metaUploaded(
                    meta?.mtime instanceof Date ||
                      typeof meta?.mtime === "string"
                      ? meta.mtime
                      : undefined
                  ),
                } satisfies StoredFile;
              })
          );
          rows.sort((a, b) => a.name.localeCompare(b.name));
          return rows;
        },
      });
      return files;
    }),
  { error: Schema.Union([UnauthorizedError, MissingAuthSecretError]) }
);

/** Delete one object owned by the signed-in user. */
export const removeFile = action(
  withSchema(FileKey, (key) =>
    Effect.gen(function* () {
      const user = yield* requireUser;
      if (!ownsFileKey(user.id, key)) {
        return yield* Effect.fail(
          new UnauthorizedError({ message: "Not your file" })
        );
      }
      const storage = filesStorage(useEnv<KitEnv>()?.FILES);
      yield* Effect.tryPromise({
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
        try: () => storage.removeItem(key),
      });
    })
  ),
  { error: Schema.Union([UnauthorizedError, MissingAuthSecretError]) }
);
