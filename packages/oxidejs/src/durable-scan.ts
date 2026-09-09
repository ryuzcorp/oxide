/**
 * Shared helpers for scanning `workflow()` / `queue()` / `schedule()` calls in
 * `*.server.ts`. Only static string literals and simple identifier refs are
 * supported — no full AST — but property reads are brace-depth-aware so nested
 * objects (e.g. `run: () => ({ name: "x" })`) do not override top-level config.
 */

/** Contents inside `fn(...)` for one export — stops at the matching `)`. */
export const extractCallInner = function extractCallInner(
  source: string,
  openParenIndex: number
): string | null {
  if (source[openParenIndex] !== "(") {
    return null;
  }
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escape = false;
  for (let i = openParenIndex; i < source.length; i += 1) {
    const c = source[i];
    if (quote !== null) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(") {
      depth += 1;
      continue;
    }
    if (c === ")") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openParenIndex + 1, i);
      }
    }
  }
  return null;
};

const isIdentChar = function isIdentChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_$]/u.test(c);
};

/**
 * Index of the first character of a top-level `key` property name in an
 * object-literal call body (typically `{ ... }`). Nested objects/arrays/
 * function bodies are skipped. Returns -1 when absent.
 */
// oxlint-disable-next-line eslint/complexity -- quote + brace/bracket/paren scanner
export const findTopLevelPropKeyIndex = function findTopLevelPropKeyIndex(
  inner: string,
  key: string
): number {
  const trimmed = inner.trimStart();
  const topBraceDepth = trimmed.startsWith("{") ? 1 : 0;
  let brace = 0;
  let bracket = 0;
  let paren = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escape = false;

  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (quote !== null) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") {
      brace += 1;
      continue;
    }
    if (c === "}") {
      brace -= 1;
      continue;
    }
    if (c === "[") {
      bracket += 1;
      continue;
    }
    if (c === "]") {
      bracket -= 1;
      continue;
    }
    if (c === "(") {
      paren += 1;
      continue;
    }
    if (c === ")") {
      paren -= 1;
      continue;
    }

    if (brace !== topBraceDepth || bracket !== 0 || paren !== 0) {
      continue;
    }
    if (isIdentChar(inner[i - 1])) {
      continue;
    }
    if (!inner.startsWith(key, i)) {
      continue;
    }
    if (isIdentChar(inner[i + key.length])) {
      continue;
    }
    let j = i + key.length;
    while (j < inner.length && /\s/u.test(inner[j] ?? "")) {
      j += 1;
    }
    // Shorthand `{ key }` or `{ key,` — no colon.
    if (inner[j] === "," || inner[j] === "}") {
      return i;
    }
    if (inner[j] === ":") {
      return i;
    }
  }
  return -1;
};

/** Slice starting at the value after a top-level `key:` (skips whitespace). */
const topLevelPropValueStart = function topLevelPropValueStart(
  inner: string,
  key: string
): number | undefined {
  const keyIndex = findTopLevelPropKeyIndex(inner, key);
  if (keyIndex < 0) {
    return;
  }
  let j = keyIndex + key.length;
  while (j < inner.length && /\s/u.test(inner[j] ?? "")) {
    j += 1;
  }
  if (inner[j] !== ":") {
    // Shorthand — no value.
    return;
  }
  j += 1;
  while (j < inner.length && /\s/u.test(inner[j] ?? "")) {
    j += 1;
  }
  return j;
};

const hasShorthandProp = function hasShorthandProp(
  inner: string,
  key: string
): boolean {
  const keyIndex = findTopLevelPropKeyIndex(inner, key);
  if (keyIndex < 0) {
    return false;
  }
  let j = keyIndex + key.length;
  while (j < inner.length && /\s/u.test(inner[j] ?? "")) {
    j += 1;
  }
  return inner[j] !== ":";
};

const hasNonLiteralProp = function hasNonLiteralProp(
  inner: string,
  key: string
): boolean {
  const start = topLevelPropValueStart(inner, key);
  if (start === undefined) {
    return false;
  }
  const c = inner[start];
  // Quoted string → literal. Anything else (ident, `(`, `{`, `` ` ``, …) is non-literal.
  return c !== '"' && c !== "'";
};

/**
 * Read `key: "literal"` only. Identifiers / expressions / shorthand throw so
 * the build never invents RPC names from variable identifiers.
 */
export const readLiteralStringProp = function readLiteralStringProp(
  inner: string,
  key: string,
  label: string
): string | undefined {
  if (hasShorthandProp(inner, key)) {
    throw new Error(
      `oxidejs: ${label} ${key}: must be a string literal (object shorthand { ${key} } is not supported by the build scanner)`
    );
  }
  const start = topLevelPropValueStart(inner, key);
  if (start === undefined) {
    return;
  }
  const quote = inner[start];
  if (quote === '"' || quote === "'") {
    let i = start + 1;
    let escape = false;
    while (i < inner.length) {
      const c = inner[i];
      if (escape) {
        escape = false;
        i += 1;
        continue;
      }
      if (c === "\\") {
        escape = true;
        i += 1;
        continue;
      }
      if (c === quote) {
        return inner.slice(start + 1, i);
      }
      i += 1;
    }
    return;
  }
  if (hasNonLiteralProp(inner, key)) {
    throw new Error(
      `oxidejs: ${label} ${key}: must be a string literal (variables and expressions are not supported by the build scanner)`
    );
  }
  return undefined;
};

/**
 * Read `key: "name"` or `key: exportIdent` for handle/name refs. Rejects
 * object shorthand and non-simple expressions.
 */
export const readRefProp = function readRefProp(
  inner: string,
  key: string,
  label: string
): string | undefined {
  if (hasShorthandProp(inner, key)) {
    throw new Error(
      `oxidejs: ${label} ${key}: must be a string literal or identifier (object shorthand { ${key} } is not supported by the build scanner — write ${key}: ${key})`
    );
  }
  const start = topLevelPropValueStart(inner, key);
  if (start === undefined) {
    return;
  }
  const quote = inner[start];
  if (quote === '"' || quote === "'") {
    let i = start + 1;
    let escape = false;
    while (i < inner.length) {
      const c = inner[i];
      if (escape) {
        escape = false;
        i += 1;
        continue;
      }
      if (c === "\\") {
        escape = true;
        i += 1;
        continue;
      }
      if (c === quote) {
        return inner.slice(start + 1, i);
      }
      i += 1;
    }
    return;
  }
  const ident = inner.slice(start).match(/^(?<name>[A-Za-z_$][\w$]*)/u);
  if (ident?.groups?.["name"]) {
    const after = start + ident.groups["name"].length;
    const next = inner[after];
    // `workflow: demo` ok; `workflow: demo.foo` / `workflow: demo()` rejected.
    if (
      next === undefined ||
      next === "," ||
      next === "}" ||
      /\s/u.test(next)
    ) {
      return ident.groups["name"];
    }
  }
  if (hasNonLiteralProp(inner, key)) {
    throw new Error(
      `oxidejs: ${label} ${key}: must be a string literal or simple identifier (expressions are not supported by the build scanner)`
    );
  }
  return undefined;
};

export const readNumberProp = function readNumberProp(
  inner: string,
  key: string
): number | undefined {
  const start = topLevelPropValueStart(inner, key);
  if (start === undefined) {
    return;
  }
  const match = inner.slice(start).match(/^(?<num>\d+(?:\.\d+)?)/u);
  if (!match?.groups?.["num"]) {
    return;
  }
  return Number(match.groups["num"]);
};

export const hasProp = function hasProp(inner: string, key: string): boolean {
  return findTopLevelPropKeyIndex(inner, key) >= 0;
};
