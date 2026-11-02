import { getLogger } from "@logtape/logtape";
import {
  type FsmDefinition,
  FsmDefinitionLoadError,
  type FsmDefinitionSummary,
  type FsmJsonRow,
  getFsmDefinition,
  listFsmDefinitions,
  type LoadFsmDefinitionResult,
  loadFsmDefinitions,
} from "@pgfsm/db";
import type { Json } from "@pgfsm/db/database.types";
import { apiRequest, query } from "../api-client.ts";
import { type ApiTarget, resolveApiTarget } from "../api-target.ts";
import { parseCommandArgs, verbOf } from "../args.ts";
import { resolveDbUrl, withPool } from "../db-target.ts";
import {
  CtlError,
  ExitCode,
  exitCodeFor,
  notFound,
  usageError,
} from "../exit.ts";
import { CLI_INVOCATION } from "../invocation.ts";
import { CTL_CATEGORY } from "../logger.ts";
import { type OutputFormat, printList, printRecord } from "../output.ts";

const logger = getLogger([CTL_CATEGORY, "fsm"]);

const HELP = `pgfsmctl fsm — FSM definitions in the database

USAGE
  ${CLI_INVOCATION} fsm load <folder> [options]
  ${CLI_INVOCATION} fsm list [-n <fsm-name>] [-V <version>] [options]
  ${CLI_INVOCATION} fsm get <fsm-name>/<version> [options]

VERBS
  load   Load every <folder>/<fsmName>/<version>/fsm.json into
         fsm_core.fsm_json, as one batch: validated first, child FSMs before
         the parents that invoke them, all in one transaction. Re-loading
         identical content is a no-op ("unchanged"); changed content under
         an existing version is refused. Exits 1 and loads nothing if any
         definition fails. Admin.
  list   Loaded definitions, by name then version, with each one's SHA-256
         digest (the one sync workers' startup check compares). Operator.
  get    One loaded definition's fsm.json (best with -o json). Exit 4 if
         that version isn't loaded. Operator.

OPTIONS
  -n, --fsm-name <name>   list: only this FSM
  -V, --fsm-version <v>   list: only this version
      --url <url>       API base URL incl. its path prefix, e.g. http://localhost:9999/api/v1
      --api-key <key>   Admin key (load) or operator key (list, get)
  -d, --db-url <url>    Postgres URL: forces DB-direct (break-glass)
      --profile <name>  Use this profile's url/api_key, or its db_url
  -o, --output <fmt>    table (default), json or ids (<fsmName>/<version>)

  list and get: API when one resolves (GET /definitions, GET
  /definitions/<name>/versions/<version>, operator key), else DB-direct, as
  below.
  -h, --help            Show this help

TIER
  API when an API target resolves (--url, else the profile's url, else
  PGFSM_URL, each with its key): POST /admin/definitions with an admin key, on an
  API running with --enable-admin-api. Otherwise DB-direct (PGFSM_DB_URL or
  DATABASE_URL, or the profile's db_url), so a project's local .env with only
  DATABASE_URL works with no API running. --db-url always means DB-direct.
  The tier used is logged. Pinned to the API (a profile's tier: api, or
  PGFSM_TIER=api), it never falls back: with no API target, or with --db-url,
  it exits 2 (#663).

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
    {
      string: ["fsm-name", "fsm-version"],
      alias: { n: "fsm-name", V: "fsm-version" },
      common: ["db", "api", "output"],
    },
    HELP,
  );
  if (args.help) return console.log(HELP);

  const verb = verbOf("fsm", args.positionals, ["load", "list", "get"], HELP);
  if (verb === "list" || verb === "get") {
    return await readDefinitions(verb, args);
  }
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
      "/admin/definitions",
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

const definitionId = (r: { fsm_name: string; fsm_version: string }) =>
  `${r.fsm_name}/${r.fsm_version}`;

/**
 * `fsm list` / `fsm get` (#661): API when an API target resolves (operator
 * key), else DB-direct; --db-url forces DB-direct.
 */
async function readDefinitions(
  verb: "list" | "get",
  args: {
    positionals: string[];
    flags: Record<string, unknown>;
    output: OutputFormat;
    dbUrl?: string;
    url?: string;
    apiKey?: string;
    profile?: string;
  },
): Promise<void> {
  const fsmName = args.flags["fsm-name"] as string | undefined;
  const fsmVersion = args.flags["fsm-version"] as string | undefined;
  let target: { fsmName: string; fsmVersion: string } | undefined;
  if (verb === "get") {
    const ref = args.positionals[1];
    const m = ref?.match(/^([^/]+)\/([^/]+)$/);
    if (!m) {
      throw usageError(
        "fsm get needs <fsm-name>/<version>, e.g. `fsm get creditCheck/v01`",
        HELP,
      );
    }
    target = { fsmName: m[1], fsmVersion: m[2] };
  }

  const api = args.dbUrl ? undefined : await resolveApiTarget(args);
  if (api) {
    logger.info(`fsm ${verb}: via the API at ${api.url} (${api.source})`);
  } else logger.info(`fsm ${verb}: DB-direct`);

  if (verb === "list") {
    const rows = api
      ? (await apiRequest<{ data: FsmDefinitionSummary[] }>(
        api,
        "GET",
        `/definitions${query({ fsm_name: fsmName, fsm_version: fsmVersion })}`,
      )).data
      : await withPool(
        await resolveDbUrl(args),
        (deps) => listFsmDefinitions(deps, { fsmName, fsmVersion }),
      );
    return printList(rows, args.output, {
      columns: ["fsm_name", "fsm_version", "fsm_type", "fsm_json_sha256"],
      id: definitionId,
    });
  }

  const { fsmName: n, fsmVersion: v } = target!;
  const row = api ? await getViaApi(api, n, v) : await withPool(
    await resolveDbUrl(args),
    (deps) => getFsmDefinition(deps, n, v),
  );
  if (!row) throw notFound(`FSM ${n}/${v} isn't loaded`);
  printRecord(
    {
      fsm_name: row.fsm_name,
      fsm_version: row.fsm_version,
      fsm_json: row.fsm_json,
    },
    args.output,
    { id: definitionId },
  );
}

async function getViaApi(
  api: ApiTarget,
  fsmName: string,
  fsmVersion: string,
): Promise<FsmJsonRow> {
  return (await apiRequest<{ data: FsmJsonRow }>(
    api,
    "GET",
    `/definitions/${encodeURIComponent(fsmName)}/versions/${
      encodeURIComponent(fsmVersion)
    }`,
  )).data;
}
