import { createStorage, normalizeBaseKey, normalizeKey } from "unstorage";
import cloudflareR2BindingDriver from "unstorage/drivers/cloudflare-r2-binding";

const missingR2 = () =>
  new Error("kit: R2 binding FILES is missing — check wrangler r2_buckets");

/** Per-user unstorage over the Worker `FILES` R2 binding. */
export const filesStorage = (bucket: R2Bucket | undefined) => {
  if (!bucket) {
    throw missingR2();
  }
  return createStorage({
    // SAFETY: unstorage's bundled R2 typings lag @cloudflare/workers-types; the Worker binding is correct at runtime.
    driver: cloudflareR2BindingDriver({ binding: bucket as never }),
  });
};

/** unstorage base for a user — trailing `:` (`u:<id>:`). */
export const userFilesBase = (userId: string) =>
  normalizeBaseKey(`u/${userId}`);

export const fileKeyFor = (userId: string, name: string) =>
  normalizeKey(`u/${userId}/${name}`);

export const ownsFileKey = (userId: string, key: string) => {
  const normalized = normalizeKey(key);
  return (
    normalized.startsWith(userFilesBase(userId)) && !normalized.includes("..")
  );
};

export const displayNameFor = (userId: string, key: string) => {
  const base = userFilesBase(userId);
  const normalized = normalizeKey(key);
  return normalized.startsWith(base)
    ? normalized.slice(base.length)
    : normalized;
};

export const safeFileName = (name: string) => {
  const base = name.split(/[/\\]/u).pop()?.trim() || "upload";
  const cleaned = base.replaceAll(/[^\w.\- ()]+/gu, "_").slice(0, 180);
  return cleaned || "upload";
};
