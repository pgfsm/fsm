import { parseArgs } from "@std/cli/parse-args";
import { getLogger } from "@logtape/logtape";
import {
  type FsmDefinition,
  FsmDefinitionLoadError,
  loadFsmDefinitions,
} from "@pgfsm/db";
import type { Json } from "@pgfsm/db/database.types";
import { CLI_INVOCATION } from "../invocation.ts";
import { CTL_CATEGORY } from "../logger.ts";
import { resolveDbUrl, withPool } from "./db.ts";

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
  -d, --db-url <url>  Database connection URL (overrides DATABASE_URL from .env)
  -h, --help          Show this help

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
  const args = parseArgs(argv, {
    string: ["db-url"],
    boolean: ["help"],
    alias: { h: "help", d: "db-url" },
  });
  const [verb, folder] = args._.map(String);

  if (args.help) {
    console.log(HELP);
    Deno.exit(0);
  }
  if (verb !== "load") {
    logger.error(
      verb === undefined
        ? "fsm needs a verb: load"
        : `Unknown fsm verb: ${verb}`,
    );
    console.log(HELP);
    Deno.exit(1);
  }
  if (folder === undefined) {
    logger.error("fsm load needs a folder, e.g. `fsm load fsm`");
    console.log(HELP);
    Deno.exit(1);
  }

  let definitions: FsmDefinition[];
  try {
    definitions = await readFsmDefinitionsFromFolder(folder);
  } catch (err) {
    logger.error(
      `fsm load: ${err instanceof Error ? err.message : String(err)}`,
    );
    Deno.exit(1);
  }
  if (definitions.length === 0) {
    logger.error(
      "fsm load: no <fsmName>/<version>/fsm.json found under {folder}",
      { folder },
    );
    Deno.exit(1);
  }

  const dbUrl = resolveDbUrl(args["db-url"]);
  try {
    const results = await withPool(
      dbUrl,
      (deps) => loadFsmDefinitions(deps, definitions),
    );
    for (const r of results) {
      // Built as plain text: LogTape quotes interpolated strings.
      logger.info(`${r.status} ${r.fsmName}/${r.fsmVersion}`);
    }
    const loaded = results.filter((r) => r.status === "loaded").length;
    logger.info(
      "fsm load: {loaded} loaded, {unchanged} unchanged.",
      { loaded, unchanged: results.length - loaded },
    );
  } catch (err) {
    if (err instanceof FsmDefinitionLoadError) {
      logger.error(
        ["fsm load: nothing loaded.", ...err.problems.map((p) => `  - ${p}`)]
          .join("\n"),
      );
    } else {
      logger.error("fsm load failed: {error}", { error: err });
    }
    Deno.exit(1);
  }
}
