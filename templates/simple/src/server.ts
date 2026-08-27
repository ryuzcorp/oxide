import { setFrameAuth } from "@ilha/router/ssr";

// Frames (server-page + server-island rendering) are deny-by-default in
// production. This demo serves world-readable state, so open them:
setFrameAuth({ defaultAction: "open" });

export default {
  fetch() {
    return undefined;
  },
};
