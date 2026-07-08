import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureCompilerLogger } from "../logger.ts";
import {
  deleteFsmJSONFromFolders,
  generateAsyncOperationLogicFromFolders,
  generateFsmJSONFromFolders,
  generateFsmJSONFromMachineFile,
  generateSyncOperationLogicFromFolders,
  isOperationLang,
  loadFsmJSONFromFolders,
  SUPPORTED_OPERATION_LANGS,
  validateAsyncOperationFromFoldersV2,
  validateSyncOperationFromFolders,
} from "../index.ts";
import type { ActorReference, OperationLang, WorkflowType } from "../index.ts";

const logger = getLogger(["@pgfsm/compiler", "cli"]);
await configureCompilerLogger();

const args = parseArgs(Deno.args, {
  string: [
    "command",
    "folder",
    "workflow-type",
    "skip-dirs",
    "available-actors",
    "db-url",
    "lang",
  ],
  boolean: ["help", "show-recommendation"],
  alias: {
    h: "help",
    c: "command",
    f: "folder",
    w: "workflow-type",
    r: "show-recommendation",
    s: "skip-dirs",
    a: "available-actors",
    d: "db-url",
    l: "lang",
  },
});

function printHelp(): void {
  logger.info(`
fsm-compiler — FSM JSON compiler CLI

USAGE
  deno run --allow-all src/cli/index.ts -c <command> -f <folder> [options]

COMMANDS
  generate                            Generate fsm.json from a folder or a .ts file
  generate-async-logic                Scaffold actor stubs (per invoke object's fsmLanguage)
  generate-sync-logic                 Scaffold action/guard/delay stubs in --lang language(s)
  delete                              Delete generated fsm.json / xstate-fsm.json files
  validate-sync-operation             Validate sync operation logic (actions/guards/delays) for an FSM folder
  validate-async-operation            Validate async operation logic (actors) for a sharedPromise folder
  load                                Load FSM JSON into the database
WORKFLOW TYPES
  fsm | sharedFsm | sharedPromise | promise

OPTIONS
  -c, --command <command>             Command to run (required)
  -f, --folder <folder>               Path to FSM folder or .ts file (required; a .ts file is accepted for generate only)
  -w, --workflow-type <type>          Workflow type (optional for generate, generate-async-logic, generate-sync-logic, delete, defaults to "fsm"; required for validate-sync-operation, validate-async-operation, load)
  -l, --lang <langs>                  Comma-separated language(s): typescript, python, rust, go. For generate-sync-logic defaults to typescript; for validate-async-operation defaults to all languages
  -r, --show-recommendation           Validate generated fsm.json against schema and show errors (generate only)
  -s, --skip-dirs <dirs>              Comma-separated list of subdirectory names to skip
  -a, --available-actors <file>       Path to a JSON file containing available actor references (for validate-sync-operation, validate-async-operation)
  -d, --db-url <url>                  PostgreSQL connection string (overrides DATABASE_URL env var)
  -h, --help                          Show this help message

ENVIRONMENT
  DATABASE_URL    Fallback connection string for load. Ignored if --db-url is provided.

EXAMPLES
  deno run --allow-all src/cli/index.ts -c generate -f apps/fsm-core-example/fsm
  deno run --allow-all src/cli/index.ts -c generate -f apps/fsm-core-example/fsm -w sharedFsm
  deno run --allow-all src/cli/index.ts -c generate -f apps/fsm-core-example/fsm --skip-dirs carVitals,taskMachineConfig
  deno run --allow-all src/cli/index.ts -c generate -f apps/fsm-core-example/fsm/creditCheck/v01/machine.ts
  deno run --allow-all src/cli/index.ts -c generate-async-logic -f apps/fsm-core-example/fsm
  deno run --allow-all src/cli/index.ts -c generate-sync-logic -f apps/fsm-core-example/fsm --lang typescript,python
  deno run --allow-all src/cli/index.ts -c validate-sync-operation -f apps/fsm-core-example/fsm -w fsm
  deno run --allow-all src/cli/index.ts -c validate-async-operation -f apps/fsm-core-example/sharedFSM -w sharedPromise
  deno run --allow-all src/cli/index.ts -c validate-async-operation -f apps/fsm-core-example/sharedFSM -w sharedPromise --lang typescript
  deno run --allow-all src/cli/index.ts -c validate-async-operation -f apps/fsm-core-example/sharedFSM -w sharedPromise --lang typescript,python
`);
}

if (args.help || Deno.args.length === 0) {
  printHelp();
  Deno.exit(0);
}

const command = args["command"];
const folder = args["folder"];
const workflowType = args["workflow-type"] as WorkflowType | undefined;
const skipDirs = args["skip-dirs"]
  ? args["skip-dirs"].split(",").map((s: string) => s.trim())
  : [];

// Languages for generate-sync-logic (comma-separated). Defaults to typescript.
const langs: OperationLang[] =
  (args["lang"]
    ? args["lang"].split(",").map((s: string) => s.trim()).filter(Boolean)
    : ["typescript"]) as OperationLang[];
if (command === "generate-sync-logic") {
  const invalidLangs = langs.filter((l) => !isOperationLang(l));
  if (invalidLangs.length > 0) {
    logger.error(
      "Invalid --lang value(s): {invalid}. Must be one of: {valid}",
      {
        invalid: invalidLangs.join(", "),
        valid: SUPPORTED_OPERATION_LANGS.join(", "),
      },
    );
    printHelp();
    Deno.exit(1);
  }
}

// Languages for validate-async-operation commands (comma-separated). Empty = all languages.
const validateLangs: OperationLang[] = args["lang"]
  ? (args["lang"].split(",").map((s: string) => s.trim()).filter(
    Boolean,
  ) as OperationLang[])
  : [];
if (command === "validate-async-operation") {
  const invalidLangs = validateLangs.filter((l) => !isOperationLang(l));
  if (invalidLangs.length > 0) {
    logger.error(
      "Invalid --lang value(s): {invalid}. Must be one of: {valid}",
      {
        invalid: invalidLangs.join(", "),
        valid: SUPPORTED_OPERATION_LANGS.join(", "),
      },
    );
    printHelp();
    Deno.exit(1);
  }
}

const VALID_WORKFLOW_TYPES: string[] = [
  "fsm",
  "sharedFsm",
  "sharedPromise",
  "promise",
];
if (workflowType && !VALID_WORKFLOW_TYPES.includes(workflowType)) {
  logger.error(
    "Invalid --workflow-type: {workflowType}. Must be one of: {valid}",
    { workflowType, valid: VALID_WORKFLOW_TYPES.join(", ") },
  );
  printHelp();
  Deno.exit(1);
}

const needsWorkflowType = [
  "validate-sync-operation",
  "validate-async-operation",
  "load",
];

const missing: string[] = [];
if (!command) missing.push("--command");
if (!folder) missing.push("--folder");
if (command && needsWorkflowType.includes(command) && !workflowType) {
  missing.push("--workflow-type");
}

if (missing.length > 0) {
  logger.error("Missing required arguments: {missing}", {
    missing: missing.join(", "),
  });
  printHelp();
  Deno.exit(1);
}

if (folder) {
  try {
    const stat = await Deno.stat(folder);
    // generate accepts .ts/.json files too; all other commands require a directory
    if (command !== "generate" && !stat.isDirectory) {
      logger.error("--folder is not a directory: {folder}", { folder });
      Deno.exit(1);
    }
  } catch {
    logger.error("--folder does not exist: {folder}", { folder });
    Deno.exit(1);
  }
}

async function loadAvailableActors(): Promise<ActorReference[]> {
  const actorsFile = args["available-actors"];
  if (!actorsFile) return [];
  try {
    const content = await Deno.readTextFile(actorsFile);
    return JSON.parse(content) as ActorReference[];
  } catch (err) {
    logger.error(
      "Failed to read --available-actors file {actorsFile}: {error}",
      { actorsFile, error: err },
    );
    Deno.exit(1);
  }
}

async function buildDeps(connectionString?: string) {
  const dbUrl = connectionString ?? (() => {
    dotenv.config({ path: ".env" });
    return Deno.env.get("DATABASE_URL");
  })();
  if (!dbUrl) {
    logger.error(
      "No database connection string provided. Use --db-url <url> or set DATABASE_URL in .env",
    );
    Deno.exit(1);
  }
  const { Pool } = await import("pg");
  return { db: new Pool({ connectionString: dbUrl }) };
}

try {
  switch (command) {
    case "generate": {
      const stat = await Deno.stat(folder!);
      if (stat.isFile) {
        const absPath = folder!.startsWith("/")
          ? folder!
          : `${Deno.cwd()}/${folder!}`;
        if (folder!.endsWith(".ts")) {
          const absDir = absPath.substring(0, absPath.lastIndexOf("/"));
          const version = absDir.split("/").at(-1) ?? "v01";
          await generateFsmJSONFromMachineFile(
            absDir,
            version,
            workflowType ?? "fsm",
            args["show-recommendation"],
          );
        } else {
          logger.error(
            "--folder is not a recognized type. Use a .ts file or a directory: {folder}",
            { folder },
          );
          Deno.exit(1);
        }
      } else {
        await generateFsmJSONFromFolders(
          folder!,
          workflowType ?? "fsm",
          skipDirs,
          args["show-recommendation"],
        );
      }
      break;
    }
    case "generate-async-logic":
      await generateAsyncOperationLogicFromFolders(
        folder!,
        workflowType ?? "fsm",
        skipDirs,
      );
      break;
    case "generate-sync-logic":
      await generateSyncOperationLogicFromFolders(
        folder!,
        workflowType ?? "fsm",
        langs,
        skipDirs,
      );
      break;
    case "delete":
      await deleteFsmJSONFromFolders(folder!, workflowType ?? "fsm", skipDirs);
      break;
    case "validate-sync-operation": {
      const availableActors = await loadAvailableActors();
      await validateSyncOperationFromFolders(
        folder!,
        workflowType!,
        skipDirs,
        availableActors,
      );
      break;
    }
    case "validate-async-operation": {
      const availableActors = await loadAvailableActors();
      await validateAsyncOperationFromFoldersV2(
        folder!,
        workflowType!,
        skipDirs,
        availableActors,
        validateLangs,
      );
      break;
    }
    case "load": {
      const deps = await buildDeps(args["db-url"]);
      await loadFsmJSONFromFolders(folder!, workflowType!, skipDirs, deps);
      break;
    }
    default:
      logger.error("Unknown command: {command}", { command });
      printHelp();
      Deno.exit(1);
  }

  logger.info("Command {command} completed successfully.", { command });
} catch (err) {
  logger.error("Command {command} failed: {error}", { command, error: err });
  Deno.exit(1);
}
