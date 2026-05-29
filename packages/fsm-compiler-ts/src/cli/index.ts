import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";

import {
  deleteFsmJSONFromFolders,
  generateFsmJSONFromFolders,
  generateFsmPluginFromFolders,
  loadAndValidateFsmFromFolders,
  loadAndValidatePromiseFromFolders,
  loadFsmJSONFromFolders,
  validateFsmPluginLoadFromFolders,
  validatePromisePluginLoadFromFolders,
} from "../index.ts";
import type { WorkflowType, ActorReference } from "../index.ts";

const args = parseArgs(Deno.args, {
  string: ["command", "folder", "workflow-type", "skip-dirs", "available-actors", "db-url"],
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
  console.log(`
fsm-compiler — FSM JSON compiler CLI

USAGE
  deno run --allow-all src/cli/index.ts -c <command> -f <folder> [options]

COMMANDS
  generate                  Generate fsm.json from machine.ts files
  generate-plugin           Generate TypeScript plugin stubs from fsm.json
  delete                    Delete generated fsm.json / xstate-fsm.json files
  validate-plugin           Validate plugin load for an FSM folder
  validate-promise-plugin   Validate plugin load for a sharedPromise folder
  load                      Load FSM JSON into the database
  load-and-validate         Load FSM JSON into DB and validate plugins
  load-and-validate-promise Load Promise workflow into DB and validate plugins

WORKFLOW TYPES
  fsm | sharedFsm | sharedPromise | promise

OPTIONS
  -c, --command <command>             Command to run (required)
  -f, --folder <folder>               Path to FSM folder (required)
  -w, --workflow-type <type>          Workflow type (optional for generate/delete, defaults to "fsm"; required for validate-plugin, validate-promise-plugin, load, load-and-validate, load-and-validate-promise)
  -r, --show-recommendation           Validate generated fsm.json against schema and show errors (generate only)
  -s, --skip-dirs <dirs>              Comma-separated list of subdirectory names to skip
  -a, --available-actors <file>       Path to a JSON file containing available actor references (for validate-plugin, validate-promise-plugin, load-and-validate, load-and-validate-promise)
  -d, --db-url <url>                  PostgreSQL connection string (overrides DATABASE_URL env var)
  -h, --help                          Show this help message

ENVIRONMENT
  DATABASE_URL    Fallback connection string for load, load-and-validate, load-and-validate-promise.
                  Ignored if --db-url is provided.

EXAMPLES
  deno run --allow-all src/cli/index.ts -c generate -f apps/fsm-core-example/fsm
  deno run --allow-all src/cli/index.ts -c generate -f apps/fsm-core-example/fsm -w sharedFsm
  deno run --allow-all src/cli/index.ts -c generate -f apps/fsm-core-example/fsm --skip-dirs carVitals,taskMachineConfig
  deno run --allow-all src/cli/index.ts -c validate-plugin -f apps/fsm-core-example/fsm -w fsm
  deno run --allow-all src/cli/index.ts -c validate-promise-plugin -f apps/fsm-core-example/sharedFSM -w sharedPromise
  deno run --allow-all src/cli/index.ts -c load-and-validate -f apps/fsm-core-example/fsm -w fsm --db-url postgresql://user:pass@localhost:5432/db
  deno run --allow-all src/cli/index.ts -c load-and-validate-promise -f apps/fsm-core-example/sharedFSM -w sharedPromise --db-url postgresql://user:pass@localhost:5432/db
`);
}

if (args.help) {
  printHelp();
  Deno.exit(0);
}

const command = args["command"];
const folder = args["folder"];
const workflowType = args["workflow-type"] as WorkflowType | undefined;
const skipDirs = args["skip-dirs"] ? args["skip-dirs"].split(",").map((s: string) => s.trim()) : [];

const VALID_WORKFLOW_TYPES: string[] = ["fsm", "sharedFsm", "sharedPromise", "promise"];
if (workflowType && !VALID_WORKFLOW_TYPES.includes(workflowType)) {
  console.error(`Error: Invalid --workflow-type "${workflowType}". Must be one of: ${VALID_WORKFLOW_TYPES.join(", ")}\n`);
  printHelp();
  Deno.exit(1);
}

const needsWorkflowType = ["validate-plugin", "validate-promise-plugin", "load", "load-and-validate", "load-and-validate-promise"];

const missing: string[] = [];
if (!command) missing.push("--command");
if (!folder) missing.push("--folder");
if (command && needsWorkflowType.includes(command) && !workflowType) missing.push("--workflow-type");

if (missing.length > 0) {
  console.error(`Error: Missing required arguments: ${missing.join(", ")}\n`);
  printHelp();
  Deno.exit(1);
}

async function loadAvailableActors(): Promise<ActorReference[]> {
  const actorsFile = args["available-actors"];
  if (!actorsFile) return [];
  try {
    const content = await Deno.readTextFile(actorsFile);
    return JSON.parse(content) as ActorReference[];
  } catch (err) {
    console.error(`Error: Failed to read --available-actors file "${actorsFile}":`, err);
    Deno.exit(1);
  }
}

async function buildDeps(connectionString?: string) {
  const dbUrl = connectionString ?? (() => {
    dotenv.config({ path: ".env" });
    return Deno.env.get("DATABASE_URL");
  })();
  if (!dbUrl) {
    console.error("Error: No database connection string provided. Use --db-url <url> or set DATABASE_URL in .env");
    Deno.exit(1);
  }
  const { Pool } = await import("pg");
  return { db: new Pool({ connectionString: dbUrl }) };
}

try {
  switch (command) {
    case "generate":
      await generateFsmJSONFromFolders(folder!, workflowType ?? "fsm", skipDirs, args["show-recommendation"]);
      break;
    case "generate-plugin":
      await generateFsmPluginFromFolders(folder!, workflowType ?? "fsm", skipDirs);
      break;
    case "delete":
      await deleteFsmJSONFromFolders(folder!, workflowType ?? "fsm", skipDirs);
      break;
    case "validate-plugin": {
      const availableActors = await loadAvailableActors();
      await validateFsmPluginLoadFromFolders(folder!, workflowType!, skipDirs, availableActors);
      break;
    }
    case "validate-promise-plugin": {
      const availableActors = await loadAvailableActors();
      await validatePromisePluginLoadFromFolders(folder!, workflowType!, skipDirs, availableActors);
      break;
    }
    case "load": {
      const deps = await buildDeps(args["db-url"]);
      await loadFsmJSONFromFolders(folder!, workflowType!, skipDirs, deps);
      break;
    }
    case "load-and-validate": {
      const deps = await buildDeps(args["db-url"]);
      const availableActors = await loadAvailableActors();
      await loadAndValidateFsmFromFolders(deps, folder!, workflowType!, skipDirs, availableActors);
      break;
    }
    case "load-and-validate-promise": {
      const deps = await buildDeps(args["db-url"]);
      const availableActors = await loadAvailableActors();
      await loadAndValidatePromiseFromFolders(deps, folder!, workflowType!, skipDirs, availableActors);
      break;
    }
    default:
      console.error(`Error: Unknown command "${command}"\n`);
      printHelp();
      Deno.exit(1);
  }

  console.log(`\nCommand "${command}" completed successfully.`);
} catch (err) {
  console.error(`\nCommand "${command}" failed:`, err);
  Deno.exit(1);
}
