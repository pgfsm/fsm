// Generates a new fsm_core version's SQL (SPEC-016): the upgrade script and
// the full scripts that build-both-pgext-and-fullsqlscript.ts then packages.
//
//   npm run generateBothPgextAndFullsqlscript -- patch|minor|major [--enable_all_supabase_service[=true|false]]
//
// --enable_all_supabase_service (default false) is passed to the restart
// script: false starts only Postgres, which is all the diff and the dump need;
// true starts every Supabase service (Studio, auth, the REST API, …).
//
// Then review the new upgrade script (its require_version() line, roles,
// grants) and package with
//   npm run buildBothPgextAndFullsqlscript -- --version <the new version>
// In order:
//
// 1. the new version: the highest in supabase/migrations/ plus the bump
//    (1.2.0 + patch = 1.2.1), computed once;
// 2. deno run supabase-restart-with-diff.ts <bump>: the upgrade script
//    supabase/migrations/<ts>_fsm_core--1.2.0--1.2.1.sql, and the local
//    Supabase restarted with every migration applied (so at 2.3.2); then a
//    check that the 2.3.2 migration exists;
// 3. deno run supabase-dump-for-full-version.ts --version 2.3.2: the full
//    script all-output/fsm_core--1.2.1.sql and its plain-SQL install
//    all-output-with-prerequisite-check/fsm_core--1.2.1.sql.
//
// The version is passed to the dump rather than the bump: after step 2 the
// highest migration is already 2.3.2, so the same bump there would give 2.3.3.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { getExistingHighestPkgVersion } from "./get-existing-highest-pkg-version.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(SCRIPT_DIR, "supabase", "migrations");
export const BUMPS = ["patch", "minor", "major"] as const;
export type Bump = typeof BUMPS[number];

/** Runs a Deno script in this directory; throws if it fails. */
function deno(script: string, scriptArgs: string[]): void {
  console.log(`\n$ deno run --allow-all ${script} ${scriptArgs.join(" ")}`);
  const r = spawnSync("deno", ["run", "--allow-all", script, ...scriptArgs], {
    cwd: SCRIPT_DIR,
    stdio: "inherit",
  });
  if (r.error) throw new Error(`can't run deno: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${script} exited with code ${r.status}`);
}

/**
 * Creates the next version (see above) and returns it. Throws if a step
 * fails, before the next one runs.
 */
export function generateNewVersion(
  bump: Bump,
  enableAllServices = false,
): string {
  const pkgName: string = JSON.parse(
    readFileSync(join(SCRIPT_DIR, "package.json"), "utf8"),
  ).name;
  const highest = () => getExistingHighestPkgVersion(pkgName, MIGRATIONS_DIR);

  // 1. The new version.
  const before = highest();
  const version = before === null ? "1.0.0" : semver.inc(before, bump)!;
  console.log(`New ${pkgName} version: ${before ?? "(none)"} → ${version}`);

  // 2. The upgrade script, and the local Supabase at the new version.
  deno("supabase-restart-with-diff.ts", [
    bump,
    `--enable_all_supabase_service=${enableAllServices}`,
  ]);
  if (highest() !== version) {
    throw new Error(
      `supabase-restart-with-diff.ts didn't create the ${version} migration (the highest is now ${highest()}).`,
    );
  }

  // 3. The full script and its plain-SQL install, dumped from that database.
  deno("supabase-dump-for-full-version.ts", ["--version", version]);
  return version;
}

// CLI entrypoint: tsx generate-both-pgext-and-fullsqlscript.ts <bump> [--enable_all_supabase_service[=true|false]]
if (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const usage =
    "Usage: tsx generate-both-pgext-and-fullsqlscript.ts patch|minor|major [--enable_all_supabase_service[=true|false]]";
  let enableAllServices = false;
  const positionals: string[] = [];
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--enable_all_supabase_service(?:=(.*))?$/);
    if (!m) positionals.push(arg);
    else if (m[1] === undefined || m[1] === "true") enableAllServices = true;
    else if (m[1] === "false") enableAllServices = false;
    else {
      console.error(
        `--enable_all_supabase_service must be true or false, got: ${
          m[1]
        }. ${usage}`,
      );
      process.exit(2);
    }
  }
  const [bump, ...rest] = positionals;
  if (rest.length > 0 || !(BUMPS as readonly string[]).includes(bump)) {
    console.error(usage);
    process.exit(2);
  }
  try {
    const version = generateNewVersion(bump as Bump, enableAllServices);
    console.log(
      `\nGenerated ${version}. Package it with: npm run buildBothPgextAndFullsqlscript -- --version ${version}`,
    );
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
