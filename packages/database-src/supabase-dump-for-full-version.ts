#!/usr/bin/env -S deno run --allow-all
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "@std/cli/parse-args";
import semver, { type ReleaseType } from "semver";
// @ts-types="@types/pg"
import pg from "pg";
import { getExistingHighestPkgVersion } from "./get-existing-highest-pkg-version.ts";
import { withPrerequisites } from "./scripts/prerequisites-sql.ts";

// Writes a full SQL file for the next fsm_core version with `supabase db dump`
// (pg_dump: objects in dependency order, function bodies unchecked):
//
//   deno run --allow-all supabase-dump-for-full-version.ts [patch|minor|major] [--db-url <url>]
//   deno run --allow-all supabase-dump-for-full-version.ts --version <x.y.z> [--db-url <url>]
//
// 1. The new version: the highest version in supabase/migrations/ plus the
//    bump (default patch), as in supabase-restart-with-diff.ts: 1.2.0 + patch
//    = 1.2.1. --version names it instead: build-both-pgext-and-fullsqlscript.ts passes the
//    version the restart script just created, which is then the highest.
// 2. Two dumps of the local Supabase (or --db-url), in this order: first the
//    schema (`supabase db dump --schema fsm_core --keep-comments`), then the
//    roles (`supabase db dump --role-only`), combined into
//    all-output/fsm_core--<new version>.sql with the roles first.
// 3. The same script with the prerequisites block in front (the same checks
//    as the full install), a plain-SQL install:
//    all-output-with-prerequisite-check/fsm_core--<new version>.sql.
//
// The dump is the database as it is: run it against a database that already
// has the new version's schema. It logs the database's fsm_core.version()
// next to the new version so a mismatch is visible.
//
// --db-url dumps another database instead of the local Supabase. The CLI's
// pg_dump is 15.x, so it can only dump PostgreSQL 15.
//
// completeFullScript() makes them one portable script:
// - roles first, from the role dump (fsmRolesSql): only fsm_* roles, each
//   created only if missing (roles are cluster-wide, so a second database or
//   a re-install finds them), without BYPASSRLS (superuser-only), plus their
//   memberships among each other (no GRANTED BY), and the installing login
//   made a member of the same fsm_* roles the dumped database's owner is;
// - then the schema dump;
// - then what neither dump sees, from the access-control schema file: the
//   pgmq grants; then the pg_cron job registration and a check that
//   fsm_core.version() is the version.
// From the schema dump it drops
// what doesn't belong in a portable script: OWNER TO lines (the installing
// login owns everything), CREATE/COMMENT ON EXTENSION (extensions come from
// the prerequisites or the control file's `requires`), CREATE SCHEMA fsm_core
// (the control file or the prerequisites create it), and grants to roles
// other than fsm_* and PUBLIC (e.g. Supabase's postgres or anon).

const SCRIPT_DIR = import.meta.dirname!;
// The project-pinned CLI, as in supabase-restart-with-diff.ts (Deno.Command
// doesn't get npm's node_modules/.bin on PATH).
const PINNED_SUPABASE_BIN = join(SCRIPT_DIR, "node_modules/.bin/supabase");
const SUPABASE_BIN = existsSync(PINNED_SUPABASE_BIN)
  ? PINNED_SUPABASE_BIN
  : "supabase";
const MIGRATIONS_DIR = join(SCRIPT_DIR, "supabase", "migrations");
const OUTPUT_DIR = join(SCRIPT_DIR, "all-output");
const PREREQUISITE_OUTPUT_DIR = join(
  SCRIPT_DIR,
  "all-output-with-prerequisite-check",
);
const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const BUMPS = ["patch", "minor", "major"] as const;
const ACCESS_CONTROL_FILE = join(
  SCRIPT_DIR,
  "supabase/schemas/40_access_control/20261005120100_fsm_core_access_control.sql",
);

/** The pgmq grants from the access-control schema file (no dump sees them). */
async function pgmqGrantsFromAccessControl(): Promise<string> {
  const sql = await Deno.readTextFile(ACCESS_CONTROL_FILE);
  const pgmqGrants = sql.split("\n").filter((line) =>
    /^(GRANT|ALTER DEFAULT PRIVILEGES)\b.*\bpgmq\b.*;\s*$/.test(line)
  );
  if (pgmqGrants.length === 0) {
    throw new Error(`No pgmq grants in ${ACCESS_CONTROL_FILE}`);
  }
  return pgmqGrants.join("\n");
}

const isFsmRole = (name: string) => name.startsWith("fsm_");

/**
 * The fsm_* part of `supabase db dump --role-only` (pg_dumpall --roles-only)
 * as idempotent, portable SQL; `ownerRoles` are the fsm_* roles to make the
 * installing login a member of.
 */
export function fsmRolesSql(roleDump: string, ownerRoles: string[]): string {
  const attributes = new Map<string, string>();
  const memberships: string[] = [];
  for (const line of roleDump.split("\n")) {
    const create = line.match(/^CREATE ROLE "([^"]+)";\s*$/);
    if (create && isFsmRole(create[1])) {
      attributes.set(create[1], attributes.get(create[1]) ?? "");
      continue;
    }
    const alter = line.match(/^ALTER ROLE "([^"]+)" WITH (.+);\s*$/);
    if (alter && isFsmRole(alter[1])) {
      attributes.set(
        alter[1],
        alter[2].split(/\s+/).filter((a) => !/^(NO)?BYPASSRLS$/.test(a))
          .join(" "),
      );
      continue;
    }
    const grant = line.match(/^GRANT "([^"]+)" TO "([^"]+)"/);
    if (grant && isFsmRole(grant[1]) && isFsmRole(grant[2])) {
      memberships.push(`GRANT "${grant[1]}" TO "${grant[2]}";`);
    }
  }
  if (attributes.size === 0) {
    throw new Error("The role dump has no fsm_* roles");
  }
  const creates = [...attributes].map(([name, attrs]) =>
    `  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${name}') THEN
    CREATE ROLE "${name}"${attrs ? ` WITH ${attrs}` : ""};
  END IF;`
  ).join("\n");
  const owner = ownerRoles.length === 0 ? "" : `
-- The installing login gets the memberships the dumped database's owner has
-- (by name: on Supabase, GRANT … TO CURRENT_USER segfaults the backend).
DO $owner$
BEGIN
  EXECUTE format('GRANT ${
    ownerRoles.map((r) => `"${r}"`).join(", ")
  } TO %I', current_user);
END;
$owner$;
`;
  return `-- ── Roles (from \`supabase db dump --role-only\`, fsm_* only) ────────────────
DO $roles$
BEGIN
${creates}
END;
$roles$;

${memberships.join("\n")}
${owner}`;
}

/** A grant or revoke to anything but fsm_* roles and PUBLIC. */
function grantsToOtherRoles(line: string): boolean {
  const m = line.match(/^(?:GRANT|REVOKE)\b.*\b(?:TO|FROM)\s+(.+?)\s*;\s*$/);
  if (!m) return false;
  return m[1].split(",").map((r) => r.trim().replace(/^"|"$/g, "")).some(
    (role) => role !== "PUBLIC" && !role.startsWith("fsm_"),
  );
}

/** The dump made into a complete, portable full script (see above). */
export async function completeFullScript(
  dump: string,
  roles: string,
  version: string,
): Promise<string> {
  const pgmqGrants = await pgmqGrantsFromAccessControl();
  const body = dump.split("\n").filter((line) =>
    !/^ALTER\s.+\sOWNER TO\s.+;\s*$/.test(line) &&
    !/^(CREATE EXTENSION|COMMENT ON EXTENSION)\b/.test(line) &&
    // The schema comes from the control file (CREATE EXTENSION, which
    // refuses to skip a schema it doesn't own) or the prerequisites block.
    !/^CREATE SCHEMA\b.*"?fsm_core"?\s*;\s*$/.test(line) &&
    !grantsToOtherRoles(line)
  ).join("\n").trimEnd();
  return `${roles}

${body}

-- pg_dump's header turned row_security off, which makes reading an RLS table
-- an error for a non-superuser; the cron registration reads cron.job.
SET row_security = on;

-- ── pgmq grants (from the access-control schema file) ──────────────────────
${pgmqGrants}

-- ── The pg_cron job ─────────────────────────────────────────────────────────
SELECT fsm_core.register_scheduler_job_v2();

-- ── Installed ───────────────────────────────────────────────────────────────
DO $installed$
BEGIN
  IF fsm_core.version() <> '${version}' THEN
    RAISE EXCEPTION 'fsm_core.version() is %, expected ${version}', fsm_core.version();
  END IF;
END;
$installed$;
`;
}

// config.toml interpolates env(...) references, which every CLI command
// parses (as in supabase-restart-with-diff.ts).
loadDotenv({ path: join(SCRIPT_DIR, "../../.env"), quiet: true });

async function run(cmd: string, args: string[]): Promise<void> {
  const { code } = await new Deno.Command(cmd, {
    args,
    cwd: SCRIPT_DIR,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with code ${code}`);
  }
}

/** The highest version in supabase/migrations/ plus `bump`. */
export function newVersion(pkgName: string, bump: ReleaseType): string {
  const highest = getExistingHighestPkgVersion(pkgName, MIGRATIONS_DIR);
  if (highest === null) return "1.0.0";
  const next = semver.inc(highest, bump);
  if (!next) {
    throw new Error(`Could not increment version ${highest} with "${bump}".`);
  }
  return next;
}

/**
 * fsm_core.version() in the database at `url` (null for a pre-baseline fsm_core), and the
 * fsm_* roles its login (the owner the dump comes from) is a member of.
 */
async function databaseInfo(
  url: string,
): Promise<{ version: string | null; ownerRoles: string[] }> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `Can't connect to ${url.replace(/:[^:@/]+@/, ":***@")}: ${
        (err as Error).message
      }. Start the local Supabase (npm run supabase:start:env) or pass --db-url.`,
    );
  }
  try {
    const { rows } = await client.query<{ version: string | null }>(
      `SELECT CASE WHEN to_regprocedure('fsm_core.version()') IS NULL THEN NULL
                   ELSE fsm_core.version() END AS version`,
    );
    const owner = await client.query<{ rolname: string }>(
      `SELECT r.rolname FROM pg_catalog.pg_auth_members m
         JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
        WHERE m.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
          AND r.rolname LIKE 'fsm\\_%' ORDER BY r.rolname`,
    );
    return {
      version: rows[0].version,
      ownerRoles: owner.rows.map((r) => r.rolname),
    };
  } finally {
    await client.end();
  }
}

export async function dumpFullVersion(
  opts: { bump: ReleaseType; version?: string; dbUrl?: string },
): Promise<{ fullScript: string; withPreCheck: string }> {
  const pkg = JSON.parse(
    await Deno.readTextFile(join(SCRIPT_DIR, "package.json")),
  );
  const pkgName: string = pkg.name;
  const version = opts.version ?? newVersion(pkgName, opts.bump);

  const { version: found, ownerRoles } = await databaseInfo(
    opts.dbUrl ?? LOCAL_DB_URL,
  );
  console.log(
    `Dumping a database at fsm_core ${
      found ?? "(no fsm_core.version())"
    } as ${pkgName} ${version}.`,
  );

  const target = opts.dbUrl ? ["--db-url", opts.dbUrl] : ["--local"];
  const tmp = await Deno.makeTempFile({ suffix: ".sql" });
  const tmpRoles = await Deno.makeTempFile({ suffix: ".sql" });
  try {
    // 1st dump: the fsm_core schema.
    await run(SUPABASE_BIN, [
      "db",
      "dump",
      ...target,
      "--workdir",
      SCRIPT_DIR,
      "--schema",
      "fsm_core",
      // Without it the CLI strips every comment line, including the ones
      // inside function bodies, so the definitions would differ from the
      // migrations'.
      "--keep-comments",
      "--file",
      tmp,
    ]);
    const dump = await Deno.readTextFile(tmp);
    // 2nd dump: the roles, from the same database (never --remote). They
    // still go first in the file: the schema's grants need them.
    await run(SUPABASE_BIN, [
      "db",
      "dump",
      ...target,
      "--workdir",
      SCRIPT_DIR,
      "--role-only",
      "--file",
      tmpRoles,
    ]);
    const roles = fsmRolesSql(await Deno.readTextFile(tmpRoles), ownerRoles);
    await Deno.mkdir(OUTPUT_DIR, { recursive: true });
    const out = join(OUTPUT_DIR, `${pkgName}--${version}.sql`);
    const fullScript =
      `-- ${pkgName} ${version}: full SQL (\`supabase db dump --schema fsm_core\`).
-- Generated by packages/database-src/supabase-dump-for-full-version.ts from a
-- database at fsm_core ${found ?? "(no fsm_core.version())"}; do not edit.
-- The fsm_* roles (--role-only dump) and the fsm_core schema (--schema
-- dump), plus the pgmq grants (access-control schema file) and the pg_cron job.

${await completeFullScript(dump, roles, version)}`;
    await Deno.writeTextFile(out, fullScript);
    // 3. The plain-SQL install: the prerequisites block + the full script.
    await Deno.mkdir(PREREQUISITE_OUTPUT_DIR, { recursive: true });
    const withPreCheck = join(
      PREREQUISITE_OUTPUT_DIR,
      `${pkgName}--${version}.sql`,
    );
    await Deno.writeTextFile(
      withPreCheck,
      withPrerequisites(
        version,
        fullScript,
        `all-output/${pkgName}--${version}.sql`,
      ),
    );
    return { fullScript: out, withPreCheck };
  } finally {
    await Deno.remove(tmp).catch(() => {});
    await Deno.remove(tmpRoles).catch(() => {});
  }
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, { string: ["db-url", "version"] });
  const [bump = "patch", ...rest] = args._.map(String);
  const version = args.version;
  if (
    rest.length > 0 || !(BUMPS as readonly string[]).includes(bump) ||
    (version !== undefined && !semver.valid(version)) ||
    (version !== undefined && args._.length > 0)
  ) {
    console.error(
      "Usage: supabase-dump-for-full-version.ts [patch|minor|major] [--db-url <url>]\n" +
        "       supabase-dump-for-full-version.ts --version <x.y.z> [--db-url <url>]",
    );
    Deno.exit(2);
  }
  const { fullScript, withPreCheck } = await dumpFullVersion({
    bump: bump as ReleaseType,
    version,
    dbUrl: args["db-url"],
  });
  console.log(`Wrote ${fullScript}`);
  console.log(`Wrote ${withPreCheck}`);
}
