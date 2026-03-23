import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";

import {
  deleteFsmJSONFromFolders,
  generateFsmJSONFromFolders,
  generateFsmPluginFromFolders,
  loadAndVerifyFsmFromFolders,
  loadFsmJSONFromFolders,
  validateFsmPluginLoadFromFolders,
} from "../index.ts";
import type { WorkflowType } from "../index.ts";

const args = parseArgs(Deno.args, {
  string: ["workflow-type"],
  boolean: ["help", "show-recommendation"],
  alias: { h: "help", w: "workflow-type", r: "show-recommendation" },
});

const [command, folder] = args._ as string[];

function printHelp(): void {
  console.log(`
fsm-compiler — FSM JSON compiler CLI

USAGE
  deno run --allow-all src/cli/index.ts <command> <folder> [options]

COMMANDS
  generate <folder> [-r]                    Generate fsm.json from machine.ts files
  generate-plugin <folder>                  Generate TypeScript plugin stubs from fsm.json
  clean <folder>                            Delete generated fsm.json / xstate-fsm.json files
  validate <folder> -w <type>               Validate plugin load for an FSM folder
  load <folder> -w <type>                   Load FSM JSON into the database
  load-and-verify <folder> -w <type>        Load and verify FSM + plugins into the database

WORKFLOW TYPES
  fsm | sharedFsm | sharedPromise | promise

OPTIONS
  -w, --workflow-type <type>  Workflow type (required for validate, load, load-and-verify)
  -r, --show-recommendation   Validate generated fsm.json against schema and show errors
  -h, --help                  Show this help message

EXAMPLES
  deno run --allow-all src/cli/index.ts generate src/example/fsm
  deno run --allow-all src/cli/index.ts validate src/example/fsm --workflow-type fsm
  deno run --allow-all src/cli/index.ts load-and-verify src/example/fsm --workflow-type fsm
`);
}

if (args.help || !command) {
  printHelp();
  Deno.exit(0);
}

if (!folder) {
  console.error(`Error: <folder> argument is required for command "${command}"\n`);
  printHelp();
  Deno.exit(1);
}

const workflowType = args["workflow-type"] as WorkflowType | undefined;
const needsWorkflowType = ["validate", "load", "load-and-verify"];

if (needsWorkflowType.includes(command) && !workflowType) {
  console.error(`Error: --workflow-type is required for command "${command}"\n`);
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
      await generateFsmJSONFromFolders(folder, "fsm", [], args["show-recommendation"]);
      break;
    case "generate-plugin":
      await generateFsmPluginFromFolders(folder, "fsm");
      break;
    case "clean":
      await deleteFsmJSONFromFolders(folder, "fsm");
      break;
    case "validate":
      await validateFsmPluginLoadFromFolders(folder, workflowType!);
      break;
    case "load": {
      const deps = await buildDeps();
      await loadFsmJSONFromFolders(folder, workflowType!, [], deps);
      break;
    }
    case "load-and-verify": {
      const deps = await buildDeps();
      await loadAndVerifyFsmFromFolders(deps, folder, workflowType!);
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
