import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";

import {
  deleteFsmJSONFromFolders,
  generateFsmJSONFromFolders,
  generateFsmPluginFromFolders,
  loadAndVerifyFsmFromFolders,
  loadAndVerifyPromiseFromFolders,
  loadFsmJSONFromFolders,
  validateFsmPluginLoadFromFolders,
} from "../index.ts";
import type { WorkflowType } from "../index.ts";

const args = parseArgs(Deno.args, {
  string: ["command", "folder", "workflow-type"],
  boolean: ["help", "show-recommendation"],
  alias: {
    h: "help",
    c: "command",
    f: "folder",
    w: "workflow-type",
    r: "show-recommendation",
  },
});

function printHelp(): void {
  console.log(`
fsm-compiler — FSM JSON compiler CLI

USAGE
  deno run --allow-all src/cli/index.ts -c <command> -f <folder> [options]

COMMANDS
  generate              Generate fsm.json from machine.ts files
  generate-plugin       Generate TypeScript plugin stubs from fsm.json
  clean                 Delete generated fsm.json / xstate-fsm.json files
  validate              Validate plugin load for an FSM folder
  load                  Load FSM JSON into the database
  load-and-verify       Load and verify FSM + plugins into the database
  load-and-verify-promise  Load and verify Promise workflow + plugins into the database

WORKFLOW TYPES
  fsm | sharedFsm | sharedPromise | promise

OPTIONS
  -c, --command <command>         Command to run (required)
  -f, --folder <folder>           Path to FSM folder (required)
  -w, --workflow-type <type>      Workflow type: required for validate, load, load-and-verify, load-and-verify-promise
  -r, --show-recommendation       Validate generated fsm.json against schema and show errors
  -h, --help                      Show this help message

EXAMPLES
  deno run --allow-all src/cli/index.ts -c generate -f apps/fsm-core-example/fsm
  deno run --allow-all src/cli/index.ts -c validate -f apps/fsm-core-example/fsm -w fsm
  deno run --allow-all src/cli/index.ts -c load-and-verify -f apps/fsm-core-example/fsm -w fsm
  deno run --allow-all src/cli/index.ts -c load-and-verify-promise -f apps/fsm-core-example/sharedFSM -w sharedPromise
`);
}

if (args.help) {
  printHelp();
  Deno.exit(0);
}

const command = args["command"];
const folder = args["folder"];
const workflowType = args["workflow-type"] as WorkflowType | undefined;

const needsWorkflowType = ["validate", "load", "load-and-verify", "load-and-verify-promise"];

const missing: string[] = [];
if (!command) missing.push("--command");
if (!folder) missing.push("--folder");
if (command && needsWorkflowType.includes(command) && !workflowType) missing.push("--workflow-type");

if (missing.length > 0) {
  console.error(`Error: Missing required arguments: ${missing.join(", ")}\n`);
  printHelp();
  Deno.exit(1);
}

async function buildDeps() {
  dotenv.config({ path: ".env" });
  const { Pool } = await import("pg");
  return { db: new Pool({ connectionString: Deno.env.get("DATABASE_URL") }) };
}

try {
  switch (command) {
    case "generate":
      await generateFsmJSONFromFolders(folder!, "fsm", [], args["show-recommendation"]);
      break;
    case "generate-plugin":
      await generateFsmPluginFromFolders(folder!, "fsm");
      break;
    case "clean":
      await deleteFsmJSONFromFolders(folder!, "fsm");
      break;
    case "validate":
      await validateFsmPluginLoadFromFolders(folder!, workflowType!);
      break;
    case "load": {
      const deps = await buildDeps();
      await loadFsmJSONFromFolders(folder!, workflowType!, [], deps);
      break;
    }
    case "load-and-verify": {
      const deps = await buildDeps();
      await loadAndVerifyFsmFromFolders(deps, folder!, workflowType!);
      break;
    }
    case "load-and-verify-promise": {
      const deps = await buildDeps();
      await loadAndVerifyPromiseFromFolders(deps, folder!, workflowType!);
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
