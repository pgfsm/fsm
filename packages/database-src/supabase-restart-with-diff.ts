#!/usr/bin/env -S deno run --allow-all
import { config as loadDotenv } from "dotenv";
import { join } from "node:path";
import type { ReleaseType } from "semver";
import { getNextPkgVersionFilename } from "./get-next-pkg-version-util.ts";

// Deno equivalent of the npm script chain:
//   supabase:restart:with:diff:withUpgradeScript:<patch|minor|major>
// Each function below mirrors one npm script in package.json; running this
// file directly performs the full chain for a given incrementType, same as
// `npm run supabase:restart:with:diff:withUpgradeScript:patch` (or :minor/:major).
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

const SCRIPT_DIR = import.meta.dirname!;
const DOCKER_VOLUME_LABEL = "label=com.supabase.cli.project=database-src";
// `npm run` prepends node_modules/.bin to PATH, so a bare `supabase` in an
// npm script resolves to the project-pinned CLI version. Deno.Command has no
// such PATH mangling, so a bare "supabase" here would instead pick up
// whatever's on the user's global PATH — silently running a different,
// possibly incompatible CLI version. Resolve the pinned binary explicitly.
// const SUPABASE_BIN = join(SCRIPT_DIR, "node_modules/.bin/supabase");
const SUPABASE_BIN = "supabase";

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

// npm run supabase:stop
async function stopSupabase(): Promise<void> {
  await run(SUPABASE_BIN, ["stop"]);
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
async function diffSchemaWithUpgradeScript(
  incrementType: ReleaseType,
): Promise<void> {
  const pkg = JSON.parse(
    await Deno.readTextFile(join(SCRIPT_DIR, "package.json")),
  );

  // Alternative: read `name` from deno.json instead of package.json, via a
  // native JSON module import (statically resolved relative to this file, no
  // readTextFile/JSON.parse needed) rather than the SCRIPT_DIR-joined
  // readTextFile approach above. deno.json currently has no "name" field —
  // it's a bare imports/tasks config — so this would require adding one back
  // before switching to it. Note the import itself would need to move to the
  // top of the file (static imports can't live inside a function).
  // import denoConfig from "./deno.json" with { type: "json" };
  // const nextVersion = getNextPkgVersionFilename(
  //   denoConfig.name,
  //   incrementType,
  //   join(SCRIPT_DIR, "supabase/migrations"),
  // );

  const nextVersion = getNextPkgVersionFilename(
    pkg.name,
    incrementType,
    join(SCRIPT_DIR, "supabase/migrations"),
  );
  await run(SUPABASE_BIN, ["db", "diff", "-f", nextVersion, "--debug"]);
}

// npm run supabase:start:env
async function startSupabaseWithEnv(): Promise<void> {
  await run(SUPABASE_BIN, ["start", "--debug"]);
}

// npm run supabase:gen:types
async function genTypes(): Promise<void> {
  const types = await runCapture(SUPABASE_BIN, [
    "gen",
    "types",
    "typescript",
    "--local",
    "--schema",
    "public,fsm_core,pgmq",
  ]);
  await Deno.writeTextFile(join(SCRIPT_DIR, "database.types.ts"), types + "\n");
}

// npm run supabase:restart:with:diff:withUpgradeScript:<patch|minor|major>
async function restartWithDiffWithUpgradeScript(
  incrementType: ReleaseType,
): Promise<void> {
  await stopSupabase();
  await cleanDockerVolume();
  await diffSchemaWithUpgradeScript(incrementType);
  await startSupabaseWithEnv();
  await genTypes();
}

if (import.meta.main) {
  const incrementType = (Deno.args[0] ?? "patch") as ReleaseType;
  await restartWithDiffWithUpgradeScript(incrementType);
}
