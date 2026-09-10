import { describe, expect, test } from "bun:test";

import { ensureWorkerDom } from "./worker-dom";

/** Hosts `ensureWorkerDom` may install or remove on `globalThis` during the test. */
interface WorkerDomHosts {
  Element?: abstract new (...args: never[]) => object;
  document?: object;
  window?: object;
}

describe("ensureWorkerDom", () => {
  test("installs document and Element globals", () => {
    // SAFETY: this test owns a temporary install/restore of the same hosts ensureWorkerDom writes.
    const g = globalThis as typeof globalThis & WorkerDomHosts;
    const saved = {
      Element: g.Element,
      document: g.document,
      window: g.window,
    };
    delete g.document;
    delete g.window;
    delete g.Element;

    try {
      ensureWorkerDom();
      expect(g.document).toBeDefined();
      expect(g.Element).toBeDefined();
      expect(g.Element?.prototype).toBeDefined();
      const el = document.createElement("div");
      el.innerHTML = "<span>ok</span>";
      expect(el.innerHTML).toBe("<span>ok</span>");
    } finally {
      if (saved.document === undefined) {
        delete g.document;
      } else {
        g.document = saved.document;
      }
      if (saved.window === undefined) {
        delete g.window;
      } else {
        g.window = saved.window;
      }
      if (saved.Element === undefined) {
        delete g.Element;
      } else {
        g.Element = saved.Element;
      }
    }
  });

  test("does not install linkedom EventTarget even when host is missing", () => {
    // SAFETY: temporary install/restore for EventTarget skip-list guard.
    const g = globalThis as typeof globalThis &
      WorkerDomHosts & {
        EventTarget?: abstract new (...args: never[]) => object;
      };
    const hostEventTarget = g.EventTarget;
    const saved = {
      EventTarget: hostEventTarget,
      document: g.document,
      window: g.window,
    };
    delete g.document;
    delete g.window;
    delete g.EventTarget;

    try {
      ensureWorkerDom();
      expect(g.EventTarget).toBeUndefined();
    } finally {
      if (saved.document === undefined) {
        delete g.document;
      } else {
        g.document = saved.document;
      }
      if (saved.window === undefined) {
        delete g.window;
      } else {
        g.window = saved.window;
      }
      if (saved.EventTarget === undefined) {
        delete g.EventTarget;
      } else {
        g.EventTarget = saved.EventTarget;
      }
    }
  });
});
