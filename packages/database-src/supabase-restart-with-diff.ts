#!/usr/bin/env -S deno run --allow-all
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { join } from "node:path";
import semver, { type ReleaseType } from "semver";
import { getExistingHighestPkgVersion } from "./get-existing-highest-pkg-version.ts";
import { SQL_LICENSE_HEADER } from "./scripts/prerequisites-sql.ts";

// Creates the upgrade script for the next fsm_core version, the Deno
// equivalent of the npm script chain
//   supabase:restart:with:diff:withUpgradeScript:<patch|minor|major>
// plus one step the npm chain doesn't do (setSchemaVersion).
//
// Invoke directly from a terminal, from any cwd:
//   ./supabase-restart-with-diff.ts [incrementType]
// or:
//   deno run --allow-all supabase-restart-with-diff.ts [incrementType]
// or:
//   deno task restart-with-diff-temp -- [incrementType]
//
// incrementType is a semver release type (patch|minor|major|...), same as
// `get-next-pkg-version.ts`'s CLI arg — defaults to "patch" if omitted.
//
// In order, against the main project (packages/database-src/supabase/):
//   1. checks the Supabase CLI runs, before changing any file;
//   2. takes the next version: the highest in supabase/migrations/ plus
//      incrementType (1.2.0 + patch = 1.2.1);
//   3. writes fsm_core.version() returning it into the schemas, so the diff
//      redefines it;
//   4. supabase stop, then removes the project's Docker volume;
//   5. supabase db diff -f fsm_core--1.2.0--1.2.1, which writes
//      supabase/migrations/<timestamp>_fsm_core--1.2.0--1.2.1.sql, then puts
//      SELECT fsm_core.require_version('1.2.0'); at its top (the diff never
//      writes it);
//   6. supabase start, which applies every migration including the new one;
//   7. supabase gen types into generated/database.types.ts.
//
// The upgrade script still needs its hand-written parts (roles and grants;
// see CLAUDE.md, "Access control"). The full scripts come from
// supabase-dump-for-full-version.ts, not from a diff.

const SCRIPT_DIR = import.meta.dirname!;
// `npm run` prepends node_modules/.bin to PATH, so a bare `supabase` in an
// npm script resolves to the project-pinned CLI version. Deno.Command has no
// such PATH mangling, so a bare "supabase" here would instead pick up
// whatever's on the user's global PATH — silently running a different,
// possibly incompatible CLI version, or fail when there's none. Resolve the
// pinned binary explicitly (`npm install` puts it there), falling back to a
// `supabase` on PATH.
const PINNED_SUPABASE_BIN = join(SCRIPT_DIR, "node_modules/.bin/supabase");
const SUPABASE_BIN = existsSync(PINNED_SUPABASE_BIN)
  ? PINNED_SUPABASE_BIN
  : "supabase";

const DOCKER_VOLUME_LABEL = "label=com.supabase.cli.project=database-src";
const TYPES_OUTPUT = "database.types.ts";
const MIGRATIONS_DIR = join(SCRIPT_DIR, "supabase", "migrations");
// The schema file whose fsm_core.version() each run sets to the new version.
const VERSION_SCHEMA_FILE = join(
  SCRIPT_DIR,
  "supabase/schemas/10_ext_helper/20261103120000_fsm_core_version.sql",
);

// Loaded up front (not just before `supabase start`) — every supabase CLI
// subcommand parses config.toml, which interpolates env(...) references
// (e.g. auth.external.google.client_id), so `supabase stop` and `supabase db
// diff` need these vars available just as much as `supabase start` does.
loadDotenv({ path: join(SCRIPT_DIR, "../../.env") });

async function run(
  cmd: string,
  args: string[],
  opts: Deno.CommandOptions = {},
): Promise<void> {
  const command = new Deno.Command(cmd, {
    args,
    cwd: SCRIPT_DIR,
    stdout: "inherit",
    stderr: "inherit",
    ...opts,
  });
  const { code } = await command.output();
  if (code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with code ${code}`);
  }
}

async function runCapture(cmd: string, args: string[]): Promise<string> {
  const command = new Deno.Command(cmd, {
    args,
    cwd: SCRIPT_DIR,
    stdout: "piped",
    stderr: "inherit",
  });
  const { code, stdout } = await command.output();
  const output = new TextDecoder().decode(stdout).trim();
  if (code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with code ${code}`);
  }
  return output;
}

/** Fails with install instructions when the Supabase CLI can't run. */
async function checkSupabaseCli(): Promise<void> {
  try {
    const version = await runCapture(SUPABASE_BIN, ["--version"]);
    console.log(`Supabase CLI ${version} (${SUPABASE_BIN})`);
  } catch (err) {
    throw new Error(
      `Can't run the Supabase CLI (${SUPABASE_BIN}): ${
        (err as Error).message
      }. Run \`npm install\` in packages/database-src (it pins the CLI in node_modules/.bin), or install supabase on PATH.`,
    );
  }
}

/** The highest version in supabase/migrations/, and the next one. */
export function nextVersion(
  pkgName: string,
  incrementType: ReleaseType,
): { from: string | null; to: string } {
  const from = getExistingHighestPkgVersion(pkgName, MIGRATIONS_DIR);
  if (from === null) return { from: null, to: "1.0.0" };
  const to = semver.inc(from, incrementType);
  if (!to) {
    throw new Error(
      `Could not increment version ${from} with increment type "${incrementType}".`,
    );
  }
  return { from, to };
}

/**
 * Writes VERSION_SCHEMA_FILE, the whole of it: fsm_core.version() returning
 * `version`, so the diff redefines it. require_version() lives in
 * 20261103130000_fsm_core_version_require_check.sql.
 */
export async function setSchemaVersion(version: string): Promise<void> {
  await Deno.writeTextFile(
    VERSION_SCHEMA_FILE,
    `-- fsm_core's installed version (SPEC-016). Written by
-- supabase-restart-with-diff.ts (setSchemaVersion) on every new version; do
-- not edit. scripts/check-fsm-core-version.ts checks it's the newest
-- migration's target.

create or replace function fsm_core.version()
returns text
language sql
immutable
as $$
  select '${version}'::text
$$;
`,
  );
  console.log(`fsm_core.version() set to ${version} in ${VERSION_SCHEMA_FILE}`);
}

// npm run supabase:stop
async function stopSupabase(): Promise<void> {
  await run(SUPABASE_BIN, ["stop", "--workdir", SCRIPT_DIR]);
}

/**
 * Puts SELECT fsm_core.require_version('<from>'); at the top of the upgrade
 * script `db diff` just wrote, so applying it to any other version stops
 * before changing anything (scripts/check-fsm-core-version.ts checks it),
 * under SQL_LICENSE_HEADER, which every fsm_core SQL artifact starts with
 * (SPEC-017). Safe to re-run: adds whichever of the two is missing.
 */
export async function addRequireVersion(
  pkgName: string,
  v: { from: string | null; to: string },
): Promise<void> {
  if (v.from === null) return; // the base install has nothing to require
  const suffix = `_${pkgName}--${v.from}--${v.to}.sql`;
  const files: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS_DIR)) {
    if (e.isFile && e.name.endsWith(suffix)) files.push(e.name);
  }
  if (files.length !== 1) {
    throw new Error(
      `Expected one migration *${suffix} in ${MIGRATIONS_DIR}, found ${files.length}`,
    );
  }
  const file = join(MIGRATIONS_DIR, files[0]);
  const original = await Deno.readTextFile(file);
  const sql = withUpgradeScriptPreamble(original, pkgName, {
    from: v.from,
    to: v.to,
  });
  if (sql === original) return;
  await Deno.writeTextFile(file, sql);
  console.log(`Added the licence header and require_version to ${files[0]}`);
}

/**
 * An upgrade script's text with SQL_LICENSE_HEADER first, then
 * SELECT fsm_core.require_version('<from>');, each added only if missing.
 */
export function withUpgradeScriptPreamble(
  sql: string,
  pkgName: string,
  v: { from: string; to: string },
): string {
  const line = `SELECT fsm_core.require_version('${v.from}');`;
  let out = sql;
  if (!out.includes(line)) {
    out =
      `-- ${pkgName} ${v.from} -> ${v.to}. Applied to any other version, it stops
-- here and changes nothing.
${line}

${out}`;
  }
  if (!out.startsWith(SQL_LICENSE_HEADER)) out = SQL_LICENSE_HEADER + out;
  return out;
}

// npm run supabase:docker:volume:clean
async function cleanDockerVolume(): Promise<void> {
  const volumes = await runCapture("docker", [
    "volume",
    "ls",
    "-q",
    "--filter",
    DOCKER_VOLUME_LABEL,
  ]);
  if (volumes) {
    await run("docker", ["volume", "rm", ...volumes.split("\n")]);
  } else {
    console.log("No matching docker volume to remove.");
  }
}

// npm run supabase:db:diff:schemafolder:sql:withUpgradeScript:<patch|minor|major>
// The upgrade script fsm_core--<from>--<to>, or fsm_core--1.0.0 for the very
// first migration.
async function diffSchema(
  pkgName: string,
  v: { from: string | null; to: string },
): Promise<void> {
  const name = v.from === null
    ? `${pkgName}--${v.to}`
    : `${pkgName}--${v.from}--${v.to}`;
  await run(SUPABASE_BIN, [
    "db",
    "diff",
    "-f",
    name,
    "--workdir",
    SCRIPT_DIR,
    "--debug",
  ]);
}

/**
 * Every Supabase service but Postgres (what CI runs with, too): the diff,
 * the dump (`db dump --local`) and `gen types --local` need only Postgres.
 */
export const NON_POSTGRES_SERVICES = [
  "gotrue",
  "realtime",
  "storage-api",
  "imgproxy",
  "kong",
  "mailpit",
  "postgrest",
  "postgres-meta",
  "studio",
  "edge-runtime",
  "logflare",
  "vector",
  "supavisor",
];

// npm run supabase:start:env
// With enableAllServices false (the default) only Postgres starts: faster,
// and far less memory. true starts every service (Studio, auth, the REST
// API, …), as `npm run supabase:start:env` does.
async function startSupabaseWithEnv(enableAllServices: boolean): Promise<void> {
  await run(SUPABASE_BIN, [
    "start",
    "--workdir",
    SCRIPT_DIR,
    ...(enableAllServices ? [] : ["-x", NON_POSTGRES_SERVICES.join(",")]),
    "--debug",
  ]);
}

/**
 * The named flag --enable_all_supabase_service: absent → false; bare or
 * `=true` → true; `=false` → false. Returns the flag and the other arguments.
 */
export function parseEnableAllServices(
  argv: string[],
): { enableAllServices: boolean; rest: string[] } {
  let enableAllServices = false;
  const rest: string[] = [];
  for (const arg of argv) {
    const m = arg.match(/^--enable_all_supabase_service(?:=(.*))?$/);
    if (!m) {
      rest.push(arg);
      continue;
    }
    if (m[1] === undefined || m[1] === "true") enableAllServices = true;
    else if (m[1] === "false") enableAllServices = false;
    else {
      throw new Error(
        `--enable_all_supabase_service must be true or false, got: ${m[1]}`,
      );
    }
  }
  return { enableAllServices, rest };
}

// npm run supabase:gen:types
async function genTypes(): Promise<void> {
  const types = await runCapture(SUPABASE_BIN, [
    "gen",
    "types",
    "typescript",
    "--local",
    "--workdir",
    SCRIPT_DIR,
    "--schema",
    "public,fsm_core,pgmq",
  ]);
  await Deno.mkdir(join(SCRIPT_DIR, "generated"), { recursive: true });
  await Deno.writeTextFile(
    join(SCRIPT_DIR, "generated", TYPES_OUTPUT),
    types + "\n",
  );
}

// npm run supabase:restart:with:diff:withUpgradeScript:<patch|minor|major>
async function restartWithDiffWithUpgradeScript(
  incrementType: ReleaseType,
  enableAllServices = false,
): Promise<void> {
  const pkg = JSON.parse(
    await Deno.readTextFile(join(SCRIPT_DIR, "package.json")),
  );
  // Before changing any file: a missing CLI must not leave the version
  // schema file bumped with no migration to match.
  await checkSupabaseCli();
  const v = nextVersion(pkg.name, incrementType);
  console.log(`Next fsm_core version: ${v.from ?? "(none)"} → ${v.to}`);
  await setSchemaVersion(v.to);
  await stopSupabase();
  await cleanDockerVolume();
  await diffSchema(pkg.name, v);
  await addRequireVersion(pkg.name, v);
  await startSupabaseWithEnv(enableAllServices);
  await genTypes();
}

if (import.meta.main) {
  const usage =
    "Usage: supabase-restart-with-diff.ts [patch|minor|major] [--enable_all_supabase_service[=true|false]]. It always writes the upgrade script; for the full scripts run supabase-dump-for-full-version.ts.";
  let parsed: ReturnType<typeof parseEnableAllServices>;
  try {
    parsed = parseEnableAllServices(Deno.args);
  } catch (err) {
    console.error(`${(err as Error).message}. ${usage}`);
    Deno.exit(2);
  }
  const [incrementType = "patch", ...rest] = parsed.rest;
  // The full-ext and both targets are gone; "main" is still accepted.
  if (rest.length > 0 && !(rest.length === 1 && rest[0] === "main")) {
    console.error(`Unexpected argument(s): ${rest.join(" ")}. ${usage}`);
    Deno.exit(2);
  }
  console.log(
    `Supabase services: ${
      parsed.enableAllServices
        ? "all"
        : "Postgres only (--enable_all_supabase_service for all)"
    }`,
  );
  await restartWithDiffWithUpgradeScript(
    incrementType as ReleaseType,
    parsed.enableAllServices,
  );
}
