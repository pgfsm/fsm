import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function escapePkgName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSemver(v: string): [number, number, number] | null {
  const parts = v.split(".");
  if (parts.length !== 3) return null;
  const nums = parts.map(Number);
  if (nums.some(isNaN)) return null;
  return nums as [number, number, number];
}

function compareSemver(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function getExistingHighestPkgVersion(
  pkgName: string,
  migrationsDir = "supabase/migrations",
): string | null {
  const pattern = new RegExp(
    `^\\d+_${escapePkgName(pkgName)}--(.+)\\.sql$`,
  );

  const files = readdirSync(migrationsDir);
  const versions: [number, number, number][] = [];

  for (const file of files) {
    const match = pattern.exec(file);
    if (!match) continue;
    for (const part of match[1].split("--")) {
      const parsed = parseSemver(part);
      if (parsed) versions.push(parsed);
    }
  }

  if (versions.length === 0) return null;

  versions.sort((a, b) => compareSemver(b, a));
  return versions[0].join(".");
}

// CLI entrypoint: tsx get-existing-highest-pkg-version.ts <pkgName>
if (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const pkgName = process.argv[2];
  if (!pkgName) {
    console.error("Usage: tsx get-existing-highest-pkg-version.ts <pkgName>");
    process.exit(1);
  }
  const result = getExistingHighestPkgVersion(pkgName);
  console.log(result ?? "(no matching migrations found)");
}
