import { setFrameAuth } from "@ilha/router/ssr";

setFrameAuth({ defaultAction: "open" });

export interface Task {
  completed: boolean;
  id: string;
  text: string;
}

export default {
  fetch() {
    // Fall through to static assets / index.html.
  },
};
