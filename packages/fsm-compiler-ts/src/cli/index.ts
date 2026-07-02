import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureCompilerLogger } from "../logger.ts";
import {
  deleteFsmJSONFromFolders,
  generateFsmJSONFromConfigFile,
  generateFsmJSONFromFolders,
  generateFsmJSONFromMachineFile,
  generateFsmPluginFromFolders,
  loadFsmJSONFromFolders,
  validateAndLoadFsmFromFolders,
  validateAndLoadPromiseFromFolders,
  validateFsmPluginLoadFromFolders,
  validatePromisePluginLoadFromFolders,
} from "../index.ts";
import type { ActorReference, WorkflowType } from "../index.ts";

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
  },
});

function printHelp(): void {
  logger.info(`
fsm-compiler — FSM JSON compiler CLI

USAGE
  deno run --allow-all src/cli/index.ts -c <command> -f <folder> [options]

COMMANDS
  generate                  Generate fsm.json from a folder, a .ts file, or a .json file
  generate-plugin           Generate TypeScript plugin stubs from fsm.json
  delete                    Delete generated fsm.json / xstate-fsm.json files
  validate-plugin           Validate plugin load for an FSM folder
  validate-promise-plugin   Validate plugin load for a sharedPromise folder
  load                      Load FSM JSON into the database
  validate-and-load         Validate FSM plugins then load into DB if validation passes
  validate-and-load-promise Validate Promise plugins then load into DB if validation passes

WORKFLOW TYPES
  fsm | sharedFsm | sharedPromise | promise

OPTIONS
  -c, --command <command>             Command to run (required)
  -f, --folder <folder>               Path to FSM folder, .ts file, or .json file (required; files accepted for generate only)
  -w, --workflow-type <type>          Workflow type (optional for generate, generate-plugin, delete, defaults to "fsm"; required for validate-plugin, validate-promise-plugin, load, validate-and-load, validate-and-load-promise)
  -r, --show-recommendation           Validate generated fsm.json against schema and show errors (generate only)
  -s, --skip-dirs <dirs>              Comma-separated list of subdirectory names to skip
  -a, --available-actors <file>       Path to a JSON file containing available actor references (for validate-plugin, validate-promise-plugin, validate-and-load, validate-and-load-promise)
  -d, --db-url <url>                  PostgreSQL connection string (overrides DATABASE_URL env var)
  -h, --help                          Show this help message

ENVIRONMENT
  DATABASE_URL    Fallback connection string for load, validate-and-load, validate-and-load-promise.
                  Ignored if --db-url is provided.

EXAMPLES
  deno run --allow-all src/cli/index.ts -c generate -f apps/fsm-core-example/fsm
  deno run --allow-all src/cli/index.ts -c generate -f apps/fsm-core-example/fsm -w sharedFsm
  deno run --allow-all src/cli/index.ts -c generate -f apps/fsm-core-example/fsm --skip-dirs carVitals,taskMachineConfig
  deno run --allow-all src/cli/index.ts -c generate -f apps/fsm-core-example/fsm/creditCheck/v01/machine.ts
  deno run --allow-all src/cli/index.ts -c generate -f apps/fsm-core-example/fsm/creditCheck/v01/config.json
  deno run --allow-all src/cli/index.ts -c validate-plugin -f apps/fsm-core-example/fsm -w fsm
  deno run --allow-all src/cli/index.ts -c validate-promise-plugin -f apps/fsm-core-example/sharedFSM -w sharedPromise
  deno run --allow-all src/cli/index.ts -c validate-and-load -f apps/fsm-core-example/fsm -w fsm --db-url postgresql://user:pass@localhost:5432/db
  deno run --allow-all src/cli/index.ts -c validate-and-load-promise -f apps/fsm-core-example/sharedFSM -w sharedPromise --db-url postgresql://user:pass@localhost:5432/db
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
  "validate-plugin",
  "validate-promise-plugin",
  "load",
  "validate-and-load",
  "validate-and-load-promise",
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
        } else if (folder!.endsWith(".json")) {
          await generateFsmJSONFromConfigFile(
            absPath,
            workflowType ?? "fsm",
            args["show-recommendation"],
          );
        } else {
          logger.error(
            "--folder is not a recognized type. Use a .ts file, a .json file, or a directory: {folder}",
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
    case "generate-plugin":
      await generateFsmPluginFromFolders(
        folder!,
        workflowType ?? "fsm",
        skipDirs,
      );
      break;
    case "delete":
      await deleteFsmJSONFromFolders(folder!, workflowType ?? "fsm", skipDirs);
      break;
    case "validate-plugin": {
      const availableActors = await loadAvailableActors();
      await validateFsmPluginLoadFromFolders(
        folder!,
        workflowType!,
        skipDirs,
        availableActors,
      );
      break;
    }
    case "validate-promise-plugin": {
      const availableActors = await loadAvailableActors();
      await validatePromisePluginLoadFromFolders(
        folder!,
        workflowType!,
        skipDirs,
        availableActors,
      );
      break;
    }
    case "load": {
      const deps = await buildDeps(args["db-url"]);
      await loadFsmJSONFromFolders(folder!, workflowType!, skipDirs, deps);
      break;
    }
    case "validate-and-load": {
      const deps = await buildDeps(args["db-url"]);
      const availableActors = await loadAvailableActors();
      await validateAndLoadFsmFromFolders(
        deps,
        folder!,
        workflowType!,
        skipDirs,
        availableActors,
      );
      break;
    }
    case "validate-and-load-promise": {
      const deps = await buildDeps(args["db-url"]);
      const availableActors = await loadAvailableActors();
      await validateAndLoadPromiseFromFolders(
        deps,
        folder!,
        workflowType!,
        skipDirs,
        availableActors,
      );
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
