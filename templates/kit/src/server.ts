import { setFrameAuth } from "@ilha/router/ssr";

setFrameAuth({ defaultAction: "open" });

export default {
  fetch() {
    // Fall through to static assets / index.html.
  },
};
