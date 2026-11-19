import { getLogger } from "@logtape/logtape";
import { apiRequest, query } from "../api-client.ts";
import { type ApiTarget, requireApiTarget } from "../api-target.ts";
import { parseCommandArgs, verbOf } from "../args.ts";
import { CtlError, ExitCode, notFound, usageError } from "../exit.ts";
import { CLI_INVOCATION } from "../invocation.ts";
import { CTL_CATEGORY } from "../logger.ts";
import { type OutputFormat, printList, printRecord } from "../output.ts";
import type {
  FsmDefinition,
  FsmDefinitionSummary,
  FsmJsonRow,
  Json,
  LoadFsmDefinitionResult,
} from "../types.ts";

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
      --url <url>         API base URL incl. its path prefix, e.g. http://localhost:9999/api/v1
      --api-key <key>     Admin key (load) or operator key (list, get)
      --profile <name>    Use this profile's url and api_key
  -o, --output <fmt>      table (default), json or ids (<fsmName>/<version>)
  -h, --help              Show this help

API
  load: POST /admin/definitions with an admin key, on an API running with
  --enable-admin-api. list and get: GET /definitions and GET
  /definitions/<name>/versions/<version> with an operator key. The API comes
  from --url (else the profile's url, else PGFSM_URL), each with its key;
  with none configured, exit 2.

DESCRIPTION
  A deploy step (SPEC-006): run it after installing fsm_core and before
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
      common: ["api", "output"],
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

  const api = await requireApiTarget(args, "fsm load");
  const { data: results } = await apiRequest<
    { data: LoadFsmDefinitionResult[] }
  >(api, "POST", "/admin/definitions", { definitions });

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

const definitionId = (r: { fsm_name: string; fsm_version: string }) =>
  `${r.fsm_name}/${r.fsm_version}`;

/** `fsm list` / `fsm get` (#661), with an operator key. */
async function readDefinitions(
  verb: "list" | "get",
  args: {
    positionals: string[];
    flags: Record<string, unknown>;
    output: OutputFormat;
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

  const api = await requireApiTarget(args, `fsm ${verb}`);

  if (verb === "list") {
    const rows = (await apiRequest<{ data: FsmDefinitionSummary[] }>(
      api,
      "GET",
      `/definitions${query({ fsm_name: fsmName, fsm_version: fsmVersion })}`,
    )).data;
    return printList(rows, args.output, {
      columns: ["fsm_name", "fsm_version", "fsm_type", "fsm_json_sha256"],
      id: definitionId,
    });
  }

  const { fsmName: n, fsmVersion: v } = target!;
  const row = await getViaApi(api, n, v);
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
