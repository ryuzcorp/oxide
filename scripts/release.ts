#!/usr/bin/env bun
/**
 * Bumps a package version in packages/ and syncs every workspace package.json
 * whose dependency on the package points exactly at the released version.
 * Any ^/~/"latest-like" prefix is kept; only the version part changes.
 * Formatting of untouched lines is preserved.
 *
 *   bun run release -n tacho -b minor
 */
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const argv = Bun.argv.slice(2);
const arg = (flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const name = arg("-n");
const bump = arg("-b");
if (!name || (bump !== "minor" && bump !== "patch")) {
  console.error("usage: bun run release -n <package> -b <minor|patch>");
  process.exit(1);
}

const pkgPath = join("packages", name, "package.json");
if (!existsSync(pkgPath)) {
  console.error(`no package ${name} under packages/`);
  process.exit(1);
}
const pkgText = readFileSync(pkgPath, "utf8");
const old = String(JSON.parse(pkgText).version);
const parts = old.split(".");
if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) {
  console.error(`${name} version is not plain semver: ${old}`);
  process.exit(1);
}
const [maj, min, pat] = parts.map(Number);
const next = bump === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;

type DepField = "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";
const DEP_FIELDS: DepField[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

// Structurally detect what to change, then rewrite just those `"key": "value"`
// substrings so untouched formatting survives byte-for-byte.
const updated: string[] = [];

function sync(path: string): boolean {
  const text = readFileSync(path, "utf8");
  const json = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
  let out = text;
  for (const field of DEP_FIELDS) {
    const deps = json[field];
    if (!deps || !(name in deps)) continue;
    const cur = String(deps[name]);
    if (!cur.endsWith(old)) continue;
    const replacement = cur.slice(0, cur.length - old.length) + next;
    const escapedCur = cur.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const key = name.replaceAll("/", "\\/");
    out = out.replaceAll(
      new RegExp(`("${key}"(\\s*:\\s*"))${escapedCur}",`, "g"),
      `$1${replacement}",`,
    );
    // last-dep entries lack the trailing comma
    out = out.replaceAll(
      new RegExp(`("${key}"(\\s*:\\s*"))${escapedCur}"`, "g"),
      `$1${replacement}"`,
    );
  }
  if (out === text) return false;
  writeFileSync(path, out);
  updated.push(`  synced ${path}`);
  return true;
}

const walk = (dir: string): void => {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (!statSync(p).isDirectory()) {
      if (e === "package.json" && p !== pkgPath) sync(p);
    } else walk(p);
  }
};

for (const root of ["packages", "templates", "apps"]) walk(root);

if (
  !pkgText.includes(`"version": "${old}"`) &&
  !new RegExp('"version":\\s*"' + old + '"').test(pkgText)
) {
  console.error(`version mismatch: ${pkgPath} does not contain "${old}"`);
  process.exit(1);
}
writeFileSync(
  pkgPath,
  pkgText.replace(new RegExp('("version"\\s*:\\s*")' + old + '"'), `$1${next}"`),
);
console.log(
  `${pkgPath}: ${old} -> ${next}\n${updated.join("\n")}\nPublish with: bun publish --cwd packages/${name}, then bun install to refresh bun.lock.`,
);
