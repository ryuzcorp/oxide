import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [passkeyClient(), adminClient()],
});

/**
 * Full document navigation. Use after login/logout so the action WebSocket
 * upgrades with the new session cookie (SPA navigate leaves a stale socket).
 */
export const hardNav = (path: string) => {
  window.location.replace(path);
};
