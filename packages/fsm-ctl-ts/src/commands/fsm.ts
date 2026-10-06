import { getLogger } from "@logtape/logtape";
import {
  type FsmDefinition,
  FsmDefinitionLoadError,
  type LoadFsmDefinitionResult,
  loadFsmDefinitions,
} from "@pgfsm/db";
import type { Json } from "@pgfsm/db/database.types";
import { apiRequest } from "../api-client.ts";
import { resolveApiTarget } from "../api-target.ts";
import { parseCommandArgs, verbOf } from "../args.ts";
import { resolveDbUrl, withPool } from "../db-target.ts";
import { CtlError, ExitCode, exitCodeFor, usageError } from "../exit.ts";
import { CLI_INVOCATION } from "../invocation.ts";
import { CTL_CATEGORY } from "../logger.ts";
import { printList } from "../output.ts";

const logger = getLogger([CTL_CATEGORY, "fsm"]);

const HELP = `pgfsmctl fsm — FSM definitions in the database

USAGE
  ${CLI_INVOCATION} fsm load <folder> [options]

VERBS
  load   Load every <folder>/<fsmName>/<version>/fsm.json into
         fsm_core.fsm_json, as one batch: validated first, child FSMs before
         the parents that invoke them, all in one transaction. Re-loading
         identical content is a no-op ("unchanged"); changed content under
         an existing version is refused. Exits 1 and loads nothing if any
         definition fails.

OPTIONS
      --url <url>       API base URL incl. its path prefix, e.g. http://localhost:9999/fsm
      --api-key <key>   Admin key for the API
  -d, --db-url <url>    Postgres URL: forces DB-direct (break-glass)
      --profile <name>  Use this profile's url/api_key, or its db_url
  -o, --output <fmt>    table (default), json or ids (<fsmName>/<version>)
  -h, --help            Show this help

TIER
  API when an API target resolves (--url, else the profile's url, else
  PGFSM_URL, each with its key): POST /admin/fsm/load with an admin key, on an
  API running with --enable-admin-api. Otherwise DB-direct (PGFSM_DB_URL or
  DATABASE_URL, or the profile's db_url), so a project's local .env with only
  DATABASE_URL works with no API running. --db-url always means DB-direct.
  The tier used is logged.

DESCRIPTION
  A deploy step (SPEC-006): run it after applying migrations and before
  starting sync workers, which refuse to start while a definition they serve
  is missing or differs from the one they were compiled from. In a pgfsm
  project: \`npm run db:load\` (loads ./fsm).
`;

/** `v01`, `v02`, …: the version folder names @pgfsm/compiler writes. */
const VERSION_FOLDER = /^v\d{2}$/;

/**
 * Every `<folder>/<fsmName>/<version>/fsm.json` under `folder`, parsed.
 * Version folders without an fsm.json are skipped; unreadable or invalid
 * JSON throws, naming the file.
 */
export async function readFsmDefinitionsFromFolder(
  folder: string,
): Promise<FsmDefinition[]> {
  const root = folder.startsWith("/") ? folder : `${Deno.cwd()}/${folder}`;
  const definitions: FsmDefinition[] = [];
  const fsmDirs = (await Array.fromAsync(Deno.readDir(root)))
    .filter((e) => e.isDirectory)
    .map((e) => e.name)
    .sort();
  for (const fsmName of fsmDirs) {
    const versions = (await Array.fromAsync(Deno.readDir(`${root}/${fsmName}`)))
      .filter((e) => e.isDirectory && VERSION_FOLDER.test(e.name))
      .map((e) => e.name)
      .sort();
    for (const fsmVersion of versions) {
      const file = `${root}/${fsmName}/${fsmVersion}/fsm.json`;
      let text: string;
      try {
        text = await Deno.readTextFile(file);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) continue;
        throw err;
      }
      let fsmJson: Json;
      try {
        fsmJson = JSON.parse(text);
      } catch (err) {
        throw new Error(`${file}: invalid JSON`, { cause: err });
      }
      definitions.push({ fsmName, fsmVersion, fsmJson });
    }
  }
  return definitions;
}

export async function fsmCommand(argv: string[]): Promise<void> {
  const args = parseCommandArgs(
    argv,
    { common: ["db", "api", "output"] },
    HELP,
  );
  if (args.help) return console.log(HELP);

  verbOf("fsm", args.positionals, ["load"], HELP);
  const folder = args.positionals[1];
  if (folder === undefined) {
    throw usageError("fsm load needs a folder, e.g. `fsm load fsm`", HELP);
  }

  let definitions: FsmDefinition[];
  try {
    definitions = await readFsmDefinitionsFromFolder(folder);
  } catch (err) {
    throw new CtlError(
      err instanceof Deno.errors.NotFound ? ExitCode.USAGE : ExitCode.GENERAL,
      `fsm load: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (definitions.length === 0) {
    throw usageError(
      `fsm load: no <fsmName>/<version>/fsm.json found under ${folder}`,
    );
  }

  // --db-url forces DB-direct; otherwise the API wins whenever it resolves.
  const api = args.dbUrl ? undefined : await resolveApiTarget(args);
  let results: LoadFsmDefinitionResult[];
  if (api) {
    logger.info(`fsm load: via the API at ${api.url} (${api.source})`);
    ({ data: results } = await apiRequest<{ data: LoadFsmDefinitionResult[] }>(
      api,
      "POST",
      "/admin/fsm/load",
      { definitions },
    ));
  } else {
    results = await loadDbDirect(args, definitions);
  }

  const loaded = results.filter((r) => r.status === "loaded").length;
  logger.info("fsm load: {loaded} loaded, {unchanged} unchanged.", {
    loaded,
    unchanged: results.length - loaded,
  });
  printList(
    results.map((r) => ({
      fsm_name: r.fsmName,
      fsm_version: r.fsmVersion,
      status: r.status,
    })),
    args.output,
    {
      columns: ["fsm_name", "fsm_version", "status"],
      id: (r) => `${r.fsm_name}/${r.fsm_version}`,
    },
  );
}

async function loadDbDirect(
  args: { dbUrl?: string; profile?: string },
  definitions: FsmDefinition[],
): Promise<LoadFsmDefinitionResult[]> {
  const dbUrl = await resolveDbUrl(args);
  logger.info("fsm load: DB-direct");
  try {
    return await withPool(
      dbUrl,
      (deps) => loadFsmDefinitions(deps, definitions),
    );
  } catch (err) {
    if (!(err instanceof FsmDefinitionLoadError)) throw err;
    throw new CtlError(
      exitCodeFor(err) === ExitCode.AUTH ? ExitCode.AUTH : ExitCode.GENERAL,
      ["fsm load: nothing loaded.", ...err.problems.map((p) => `  - ${p}`)]
        .join("\n"),
      undefined,
      { cause: err },
    );
  }
}
