import * as linkedom from "linkedom";

const SKIP_LINKEDOM_KEYS = new Set([
  "parseHTML",
  "parseJSON",
  "toJSON",
  "Document",
  // Never install linkedom stand-ins for host event / fetch APIs — even when
  // the global is missing at install time. Overwriting EventTarget broke
  // WebSocketPair message delivery on celld/workerd.
  "Event",
  "EventTarget",
  "CustomEvent",
]);

/** Install a minimal DOM on `globalThis` for Ilha `renderToString` in Workers. */
export const ensureWorkerDom = function ensureWorkerDom() {
  if (globalThis.document !== undefined) {
    return;
  }
  const window = linkedom.parseHTML(
    "<!DOCTYPE html><html><body></body></html>"
  );
  Reflect.set(globalThis, "document", window.document);
  Reflect.set(globalThis, "window", window);
  for (const [key, value] of Object.entries(linkedom)) {
    if (SKIP_LINKEDOM_KEYS.has(key)) {
      continue;
    }
    if (!/^[A-Z]/u.test(key)) {
      continue;
    }
    // Never replace host globals. Overwriting EventTarget/Event with linkedom's
    // DOMEventTarget breaks WebSocketPair message delivery on celld/workerd.
    if (Object.getOwnPropertyDescriptor(globalThis, key) !== undefined) {
      continue;
    }
    // Constructors own a `.prototype`; linkedom also exports plain objects (Facades, HTMLClasses).
    // SAFETY: PascalCase linkedom exports are objects or functions — never null/primitives here.
    const candidate = value as object;
    if (!("prototype" in candidate)) {
      continue;
    }
    Reflect.set(globalThis, key, value);
  }
};
