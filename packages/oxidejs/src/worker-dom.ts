import * as linkedom from "linkedom";

/** Install a minimal DOM on `globalThis` for Ilha `renderToString` in Workers. */
export function ensureWorkerDom() {
  if (typeof globalThis.document !== "undefined") return;
  const window = linkedom.parseHTML("<!DOCTYPE html><html><body></body></html>");
  const g = globalThis as typeof globalThis & Record<string, unknown>;
  g.document = window.document;
  g.window = window;
  for (const [key, value] of Object.entries(linkedom)) {
    if (key === "parseHTML" || key === "parseJSON" || key === "toJSON" || key === "Document")
      continue;
    if (typeof value === "function" && /^[A-Z]/.test(key)) g[key] = value;
  }
}
