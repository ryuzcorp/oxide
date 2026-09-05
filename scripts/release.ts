#!/usr/bin/env bun
/**
 * Bumps a package version in packages/ and syncs every workspace package.json
 * whose dependency on the package points exactly at the released version.
 * Any ^/~/"latest-like" prefix is kept; only the version part changes.
 * Formatting of untouched lines is preserved.
 *
 *   bun run release -n oxidejs -b minor
 */
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
} from "node:fs";
import path from "node:path";

const argv = Bun.argv.slice(2);
const arg = (flag: string) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};

const name = arg("-n");
const bump = arg("-b");
if (!name || (bump !== "minor" && bump !== "patch")) {
  console.error("usage: bun run release -n <package> -b <minor|patch>");
  process.exit(1);
}

const pkgPath = path.join("packages", name, "package.json");
if (!existsSync(pkgPath)) {
  console.error(`no package ${name} under packages/`);
  process.exit(1);
}
const pkgText = readFileSync(pkgPath, "utf-8");
const old = String(JSON.parse(pkgText).version);
const parts = old.split(".");
if (parts.length !== 3 || parts.some((p) => !/^\d+$/u.test(p))) {
  console.error(`${name} version is not plain semver: ${old}`);
  process.exit(1);
}
const [maj, min, pat] = parts.map(Number);
const next =
  bump === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;

type DepField =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies"
  | "optionalDependencies";
const DEP_FIELDS: DepField[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

interface PackageJsonDeps {
  dependencies?: { [key: string]: string };
  devDependencies?: { [key: string]: string };
  optionalDependencies?: { [key: string]: string };
  peerDependencies?: { [key: string]: string };
  version?: string;
}

// Structurally detect what to change, then rewrite just those `"key": "value"`
// substrings so untouched formatting survives byte-for-byte.
const updated: string[] = [];

const sync = function sync(filePath: string): boolean {
  const text = readFileSync(filePath, "utf-8");
  // SAFETY: workspace package.json dep maps are string-keyed version ranges.
  const json = JSON.parse(text) as PackageJsonDeps;
  let out = text;
  for (const field of DEP_FIELDS) {
    const deps = json[field];
    if (!deps || !(name in deps)) {
      continue;
    }
    const cur = String(deps[name]);
    if (!cur.endsWith(old)) {
      continue;
    }
    const replacement = cur.slice(0, cur.length - old.length) + next;
    const escapedCur = cur.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const key = name.replaceAll("/", "\\/");
    out = out.replaceAll(
      new RegExp(`("${key}"(\\s*:\\s*"))${escapedCur}",`, "gu"),
      `$1${replacement}",`
    );
    // last-dep entries lack the trailing comma
    out = out.replaceAll(
      new RegExp(`("${key}"(\\s*:\\s*"))${escapedCur}"`, "gu"),
      `$1${replacement}"`
    );
  }
  if (out === text) {
    return false;
  }
  writeFileSync(filePath, out);
  updated.push(`  synced ${filePath}`);
  return true;
};

const walk = (dir: string): void => {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git" || e.startsWith(".")) {
      continue;
    }
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) {
      walk(p);
    } else if (e === "package.json" && p !== pkgPath) {
      sync(p);
    }
  }
};

for (const root of ["packages", "templates", "apps"]) {
  walk(root);
}

if (
  !pkgText.includes(`"version": "${old}"`) &&
  !new RegExp(`"version":\\s*"${old}"`, "u").test(pkgText)
) {
  console.error(`version mismatch: ${pkgPath} does not contain "${old}"`);
  process.exit(1);
}
writeFileSync(
  pkgPath,
  pkgText.replace(new RegExp(`("version"\\s*:\\s*")${old}"`, "u"), `$1${next}"`)
);
console.log(
  `${pkgPath}: ${old} -> ${next}\n${updated.join("\n")}\nPublish with: bun publish --cwd packages/${name}, then bun install to refresh bun.lock.`
);
