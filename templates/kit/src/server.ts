import { setFrameAuth } from "@ilha/router/ssr";
import { FindMyWay } from "effect/unstable/http";
import type { ServerEntry } from "oxidejs";

import { authFromEnv, MissingAuthSecretError } from "./lib/auth";
import { ensureDb, missingD1 } from "./lib/db";
import { fileKeyFor, filesStorage, safeFileName } from "./lib/files-storage";

setFrameAuth({ defaultAction: "open" });

type RouteHandler = (
  request: Request,
  env: KitEnv
) => Response | undefined | Promise<Response | undefined>;

const configErrorResponse = (error: { message: string }) =>
  new Response(error.message, { status: 500 });

const handleAuth: RouteHandler = async (request, env) => {
  if (!env.DB) {
    return configErrorResponse(missingD1());
  }

  await ensureDb(env.DB);
  try {
    const auth = authFromEnv(env.DB, env, new URL(request.url).origin);
    return auth.handler(request);
  } catch (error) {
    if (error instanceof MissingAuthSecretError) {
      return configErrorResponse(error);
    }
    throw error;
  }
};

/** Multipart upload into R2 via unstorage (actions stay JSON-RPC). */
const handleUpload: RouteHandler = async (request, env) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (!env.DB) {
    return configErrorResponse(missingD1());
  }

  await ensureDb(env.DB);
  let auth;
  try {
    auth = authFromEnv(env.DB, env, new URL(request.url).origin);
  } catch (error) {
    if (error instanceof MissingAuthSecretError) {
      return configErrorResponse(error);
    }
    throw error;
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }

  let storage;
  try {
    storage = filesStorage(env.FILES);
  } catch (error) {
    return configErrorResponse(
      error instanceof Error ? error : { message: String(error) }
    );
  }

  const form = await request.formData();
  const entry = form.get("file");
  if (!(entry instanceof File) || entry.size === 0) {
    return new Response("Expected non-empty file field", { status: 400 });
  }

  const name = safeFileName(entry.name);
  const key = fileKeyFor(session.user.id, name);
  await storage.setItemRaw(key, entry.stream(), {
    httpMetadata: {
      contentType: entry.type || "application/octet-stream",
    },
  });

  return Response.json({ key, name, size: entry.size });
};

const router = FindMyWay.make<RouteHandler>();
router.all("/api/auth", handleAuth);
router.all("/api/auth/*", handleAuth);
router.all("/api/files", handleUpload);

export default {
  fetch(request, env) {
    // FindMyWay route lookup (method, path) — not Array.prototype.find.
    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- router API
    const match = router.find(request.method, new URL(request.url).pathname);
    if (!match) {
      return;
    }
    return match.handler(request, env);
  },
} satisfies ServerEntry<KitEnv>;
