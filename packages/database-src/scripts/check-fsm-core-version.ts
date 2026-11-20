// Keeps fsm_core.version() honest (SPEC-016, #688). Fails when:
//
// - the version in supabase/schemas/10_ext_helper/…_fsm_core_version.sql
//   isn't the newest migration's target version;
// - an upgrade script after the 1.2.0 baseline doesn't redefine
//   fsm_core.version() to return its target version;
// - an upgrade script after the 1.2.0 baseline doesn't start with
//   SELECT fsm_core.require_version('<the version it upgrades from>'); before
//   any other statement, so applying it to the wrong version changes nothing.
//
//   deno run --allow-read scripts/check-fsm-core-version.ts
//
// Run from anywhere: paths resolve from this file. CI and a prek hook run it.

import { migrationChain } from "./migration-chain.ts";

const root = new URL("../", import.meta.url);
const migrationsDir = new URL("supabase/migrations/", root);
const versionFile = new URL(
  "supabase/schemas/10_ext_helper/20261103120000_fsm_core_version.sql",
  root,
);
/**
 * The baseline (#697): the first version in the chain, which has
 * fsm_core.version() and require_version() from the start.
 */
const FIRST = "1.2.0";

function semverAtLeast(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return true;
}

/** The literal fsm_core.version() returns in this SQL, if it defines it. */
export function definedVersion(sql: string): string | null {
  const m = sql.match(
    /create\s+or\s+replace\s+function\s+fsm_core\.version\s*\(\s*\)[\s\S]*?select\s+'([\d.]+)'::text/i,
  );
  return m ? m[1] : null;
}

/** The first statement, ignoring comments and blank lines. */
export function firstStatement(sql: string): string {
  const body = sql
    .split("\n")
    .filter((l) => !/^\s*(--.*)?$/.test(l))
    .join("\n");
  return body.slice(0, body.indexOf(";") + 1).trim();
}

export async function check(): Promise<string[]> {
  const files: string[] = [];
  for await (const e of Deno.readDir(migrationsDir)) {
    if (e.isFile && e.name.endsWith(".sql")) files.push(e.name);
  }
  const chain = migrationChain(files);
  const newest = chain[chain.length - 1].to;
  const problems: string[] = [];

  const schemaVersion = definedVersion(await Deno.readTextFile(versionFile));
  if (schemaVersion !== newest) {
    problems.push(
      `${versionFile.pathname}: fsm_core.version() returns ${schemaVersion}, but the newest migration is ${newest}`,
    );
  }

  for (const m of chain) {
    if (m.from === null || !semverAtLeast(m.to, FIRST)) continue;
    const sql = await Deno.readTextFile(new URL(m.file, migrationsDir));
    const defined = definedVersion(sql);
    if (defined !== m.to) {
      problems.push(
        `${m.file}: must redefine fsm_core.version() to return '${m.to}' (found ${
          defined ?? "none"
        })`,
      );
    }
    if (m.to !== FIRST) {
      const expected = new RegExp(
        `^select\\s+fsm_core\\.require_version\\(\\s*'${
          m.from.replaceAll(".", "\\.")
        }'\\s*\\)\\s*;$`,
        "i",
      );
      if (!expected.test(firstStatement(sql))) {
        problems.push(
          `${m.file}: must start with SELECT fsm_core.require_version('${m.from}');`,
        );
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  const problems = await check();
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    Deno.exit(1);
  }
  console.log("fsm_core.version() matches the migration chain.");
}
