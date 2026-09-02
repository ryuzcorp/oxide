import { describe, expect, test } from "bun:test";
import { ensureWorkerDom } from "./worker-dom";

describe("ensureWorkerDom", () => {
  test("installs document and Element globals", () => {
    const saved = {
      document: globalThis.document,
      window: globalThis.window,
      Element: (globalThis as { Element?: unknown }).Element,
    };
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { Element?: unknown }).Element;

    try {
      ensureWorkerDom();
      expect(typeof globalThis.document).toBe("object");
      expect(typeof (globalThis as { Element?: unknown }).Element).toBe("function");
      const el = document.createElement("div");
      el.innerHTML = "<span>ok</span>";
      expect(el.innerHTML).toBe("<span>ok</span>");
    } finally {
      if (saved.document) globalThis.document = saved.document;
      else delete (globalThis as { document?: unknown }).document;
      if (saved.window) globalThis.window = saved.window;
      else delete (globalThis as { window?: unknown }).window;
      if (saved.Element) (globalThis as { Element: unknown }).Element = saved.Element;
      else delete (globalThis as { Element?: unknown }).Element;
    }
  });
});
