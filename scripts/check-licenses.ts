// Keeps the licence split of SPEC-017 honest (#709). REUSE.toml is the source
// of truth: the engine is AGPL-3.0-only, everything else Apache-2.0. Fails
// when:
//
// - a package declares a licence that differs from its path's REUSE.toml
//   licence: the `license` field of deno.json, package.json, Cargo.toml,
//   pyproject.toml or a PGXN META.json, or `license:` in scripts/build-npm.ts
//   (this is how three packages drifted to MIT);
// - a package's LICENSE file holds a different licence's text, or a package
//   has no LICENSE file at all;
// - shipped Apache-2.0 code (a package's src/ or gen/, tests excluded) imports
//   an AGPL-3.0-only file or package. Apache-2.0 code can go into an AGPL
//   work, but not the other way round.
//
// Usage: deno run --allow-read scripts/check-licenses.ts [root]
// Run from anywhere; root defaults to the repository root. CI and prek run it.

import { parse as parseToml } from "jsr:@std/toml@1";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "target",
  ".venv",
  "pgxn-dist",
  "full-release",
  ".claude",
]);

/** A REUSE.toml annotation: path globs and their SPDX licence. */
export interface Annotation {
  globs: RegExp[];
  license: string;
}

/** REUSE glob → RegExp: `**` crosses directories, `*` doesn't. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function parseAnnotations(reuseToml: string): Annotation[] {
  const doc = parseToml(reuseToml) as {
    annotations?: {
      path: string | string[];
      "SPDX-License-Identifier": string;
    }[];
  };
  return (doc.annotations ?? []).map((a) => ({
    globs: (Array.isArray(a.path) ? a.path : [a.path]).map(globToRegExp),
    license: a["SPDX-License-Identifier"],
  }));
}

/** The licence of a repo-relative path: the LAST matching annotation wins. */
export function licenseOf(
  path: string,
  annotations: Annotation[],
): string | null {
  let found: string | null = null;
  for (const a of annotations) {
    if (a.globs.some((g) => g.test(path))) found = a.license;
  }
  return found;
}

/** Every file under `dir` (repo-relative paths), skipping build output. */
export async function listFiles(root: string, dir = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(`${root}/${dir}` || root)) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory) {
      if (!SKIP_DIRS.has(e.name)) out.push(...await listFiles(root, rel));
    } else if (e.isFile) out.push(rel);
  }
  return out;
}

const PGXN_TO_SPDX: Record<string, string> = {
  agpl_3: "AGPL-3.0-only",
  apache_2_0: "Apache-2.0",
  mit: "MIT",
  postgresql: "PostgreSQL",
};

/** The licence a manifest or build script declares, if any. */
export function declaredLicense(file: string, text: string): string | null {
  const name = file.split("/").pop()!;
  if (name === "deno.json" || name === "package.json") {
    const v = JSON.parse(text).license;
    return typeof v === "string" ? v : null;
  }
  if (name === "META.json") {
    const v = JSON.parse(text).license;
    if (typeof v !== "string" || v.startsWith("{{")) return null; // template
    return PGXN_TO_SPDX[v] ?? v;
  }
  if (name === "Cargo.toml" || name === "pyproject.toml") {
    const m = text.match(/^license\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  }
  if (file.endsWith("scripts/build-npm.ts")) {
    const m = text.match(/\blicense:\s*"([^"]+)"/);
    return m ? m[1] : null;
  }
  return null;
}

/** Which licence a LICENSE file's text is. */
export function licenseFileKind(text: string): string | null {
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/.test(text)) return "AGPL-3.0-only";
  if (/Apache License\s+Version 2\.0/.test(text)) return "Apache-2.0";
  if (
    /\bMIT License\b|Permission is hereby granted, free of charge/.test(text)
  ) {
    return "MIT";
  }
  return null;
}

const MANIFESTS = new Set([
  "deno.json",
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "META.json",
  "go.mod",
]);

/** Directories under packages/ that are packages: they hold a manifest. */
function packageDirs(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    if (!f.startsWith("packages/")) continue;
    const parts = f.split("/");
    if (MANIFESTS.has(parts[parts.length - 1]) && !f.includes("/test")) {
      dirs.add(parts.slice(0, -1).join("/"));
    }
  }
  return [...dirs].sort();
}

/** The nearest LICENSE file from `dir` up to its packages/<name> folder. */
function nearestLicenseFile(dir: string, files: Set<string>): string | null {
  const parts = dir.split("/");
  for (let n = parts.length; n >= 2; n--) {
    const candidate = `${parts.slice(0, n).join("/")}/LICENSE`;
    if (files.has(candidate)) return candidate;
  }
  return null;
}

/** Problems with declared licences and LICENSE files. */
export async function checkDeclarations(
  root: string,
  files: string[],
  annotations: Annotation[],
): Promise<string[]> {
  const problems: string[] = [];
  const fileSet = new Set(files);
  for (const f of files) {
    if (!f.startsWith("packages/")) continue;
    const name = f.split("/").pop()!;
    if (!MANIFESTS.has(name) && !f.endsWith("scripts/build-npm.ts")) continue;
    let declared: string | null;
    try {
      declared = declaredLicense(f, await Deno.readTextFile(`${root}/${f}`));
    } catch {
      continue; // not a JSON manifest we understand (e.g. a template)
    }
    if (declared === null) continue;
    const expected = licenseOf(f, annotations);
    if (declared !== expected) {
      problems.push(
        `${f}: declares ${declared}, but REUSE.toml says ${expected}`,
      );
    }
  }
  for (const dir of packageDirs(files)) {
    const licenseFile = nearestLicenseFile(dir, fileSet);
    if (!licenseFile) {
      problems.push(`${dir}: no LICENSE file in it or its package folder`);
      continue;
    }
    const kind = licenseFileKind(
      await Deno.readTextFile(`${root}/${licenseFile}`),
    );
    const expected = licenseOf(licenseFile, annotations);
    if (kind !== expected) {
      problems.push(
        `${licenseFile}: holds ${
          kind ?? "an unrecognised licence"
        }, but REUSE.toml says ${expected}`,
      );
    }
  }
  return [...new Set(problems)];
}

const IMPORT_PATTERNS = [
  // import … from "x" / export … from "x" (multi-line too)
  /(?:^|[\s;])(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']/g,
  // import "x" (side effects)
  /(?:^|[\s;])import\s*["']([^"']+)["']/g,
  // import("x")
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/** Import specifiers in TypeScript source, comments removed first. */
export function importSpecifiers(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const out: string[] = [];
  for (const re of IMPORT_PATTERNS) {
    for (const m of code.matchAll(re)) out.push(m[1]);
  }
  return out;
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

const IS_TEST = /(^|\/)(test|tests)\/|[._]test\.(ts|tsx|js)$/;

/** Problems where shipped Apache-2.0 code imports AGPL-3.0-only code. */
export async function checkImports(
  root: string,
  files: string[],
  annotations: Annotation[],
): Promise<string[]> {
  const agplPackageNames = new Set<string>();
  for (const f of files) {
    if (!f.startsWith("packages/") || !f.endsWith("/deno.json")) continue;
    if (licenseOf(f, annotations) !== "AGPL-3.0-only") continue;
    const pkg = JSON.parse(await Deno.readTextFile(`${root}/${f}`)).name;
    if (typeof pkg === "string") agplPackageNames.add(pkg);
  }
  const problems: string[] = [];
  for (const f of files) {
    if (!/^packages\/[^/]+\/(.+\/)?(src|gen)\//.test(f)) continue;
    if (!/\.(ts|tsx|js|mjs)$/.test(f) || IS_TEST.test(f)) continue;
    if (licenseOf(f, annotations) !== "Apache-2.0") continue;
    const source = await Deno.readTextFile(`${root}/${f}`);
    for (const spec of importSpecifiers(source)) {
      if (spec.startsWith(".")) {
        const dir = f.split("/").slice(0, -1).join("/");
        const target = normalize(`${dir}/${spec}`);
        if (licenseOf(target, annotations) === "AGPL-3.0-only") {
          problems.push(
            `${f}: Apache-2.0 code imports AGPL-3.0-only ${target}`,
          );
        }
        continue;
      }
      const bare = spec.replace(/^(jsr|npm):/, "");
      for (const pkg of agplPackageNames) {
        if (
          bare === pkg || bare.startsWith(`${pkg}/`) ||
          bare.startsWith(`${pkg}@`)
        ) {
          problems.push(
            `${f}: Apache-2.0 code imports AGPL-3.0-only package ${spec}`,
          );
        }
      }
    }
  }
  return [...new Set(problems)];
}

export async function check(root: string): Promise<string[]> {
  const annotations = parseAnnotations(
    await Deno.readTextFile(`${root}/REUSE.toml`),
  );
  const files = await listFiles(root);
  return [
    ...await checkDeclarations(root, files, annotations),
    ...await checkImports(root, files, annotations),
  ];
}

if (import.meta.main) {
  const root = Deno.args[0] ??
    new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const problems = await check(root);
  if (problems.length > 0) {
    console.error(
      `Licence problems (SPEC-017; REUSE.toml is the source of truth):\n  ${
        problems.join("\n  ")
      }`,
    );
    Deno.exit(1);
  }
  console.log("Declared licences and imports match REUSE.toml (SPEC-017).");
}
