import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureCompilerLogger } from "../logger.ts";
import {
  createAsyncOperationLogic,
  deleteFsmJSONFromFolders,
  generateAsyncOperationLogicFromFolders,
  generateAsyncOperationLogicFromFsmJson,
  generateFsmJSONFromFolders,
  generateFsmJSONFromMachineFile,
  generateSyncOperationLogicFromFolders,
  generateSyncOperationLogicFromFsmJson,
  isOperationLang,
  loadFsmJSONFromFolders,
  resolvePluginRootAbsPath,
  SUPPORTED_OPERATION_LANGS,
  validateAsyncOperationFromFolders,
  validateSyncOperationFromFolders,
} from "../index.ts";
import type {
  ActorReference,
  OperationLang,
  WorkerSdkProtocol,
  WorkflowType,
} from "../index.ts";

const WORKER_SDK_PROTOCOLS: WorkerSdkProtocol[] = ["grpc", "legacy"];

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
    "worker-sdk-protocol",
    "version",
    "name",
    "output",
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
    p: "worker-sdk-protocol",
    v: "version",
    n: "name",
    o: "output",
  },
});

function printHelp(): void {
  logger.info(`
fsm-compiler — FSM JSON compiler CLI

USAGE
  deno run --allow-all src/cli/index.ts -c <command> -f <folder> [options]

COMMANDS
  generate-fsm-json                   Generate fsm.json from a folder or a single machine.ts file (--output required for a single machine.ts file)
  generate-async-logic                Scaffold actor stubs (per invoke object's asyncOperationLanguage), for a plugin-root folder or a single fsm.json (--output required for a single fsm.json). The aggregate registry/worker SDK are written one level above --folder (the app root) in folder mode, or to --output in single-fsm.json mode
  generate-sync-logic                 Scaffold action/guard/delay stubs in --lang language(s), for a plugin-root folder or a single fsm.json (--output required)
  create-async-logic                  Scaffold a single actor stub in the shared-async-op pool
  delete                              Delete generated fsm.json / xstate-fsm.json files
  validate-sync-operation             Validate sync operation logic (actions/guards/delays) for an FSM folder
  validate-async-operation            [DEPRECATED] Validate async operation logic (actors) for a sharedAsyncOperation folder — unsupported under the npm/npx build, requires the Deno-native CLI
  load                                Load FSM JSON into the database
WORKFLOW TYPES
  fsm | sharedAsyncOperation | internalAsyncOperation

OPTIONS
  -c, --command <command>             Command to run (required)
  -f, --folder <folder>               Path to FSM folder, .ts file, or fsm.json file (required; a .ts file is accepted for generate-fsm-json only, and requires --output; a fsm.json file is accepted for generate-sync-logic/generate-async-logic only, and requires --output; app root for create-async-logic)
  -w, --workflow-type <type>          Workflow type (required for validate-sync-operation, load)
  -l, --lang <langs>                  Comma-separated language(s): typescript, python, rust, go. For generate-sync-logic defaults to typescript; for validate-async-operation defaults to all languages; for create-async-logic a single language is required
  -v, --version <version>             FSM version folder name, e.g. v01 (create-async-logic only, required)
  -o, --output <folder>                Version folder to write generated output into, when --folder is a single machine.ts file (generate-fsm-json) or a single fsm.json file (generate-sync-logic/generate-async-logic); required in those cases, unused otherwise. Relative (resolved against cwd) or absolute; independent of --folder's location. For generate-async-logic single-fsm.json mode, this also doubles as the destination for the aggregate registry/worker SDK (worker-sdk-generated/)
  -n, --name <name>                   Actor function name, used for <name>/<name>.ext (create-async-logic only, required)
  -r, --show-recommendation           Validate generated fsm.json against schema and show errors (generate-fsm-json only)
  -s, --skip-dirs <dirs>              Comma-separated list of subdirectory names to skip
  -a, --available-actors <file>       Path to a JSON file containing available actor references (for validate-sync-operation, validate-async-operation)
  -d, --db-url <url>                  PostgreSQL connection string (overrides DATABASE_URL env var)
  -p, --worker-sdk-protocol <proto>   Sidecar wire protocol for generated worker SDKs: grpc (default) or legacy (generate-async-logic only)
  -h, --help                          Show this help message

ENVIRONMENT
  DATABASE_URL    Fallback connection string for load. Ignored if --db-url is provided.

EXAMPLES
  deno run --allow-all src/cli/index.ts -c generate-fsm-json -f apps/fsm-core-example/fsm
  deno run --allow-all src/cli/index.ts -c generate-fsm-json -f apps/fsm-core-example/fsm --skip-dirs carVitals,taskMachineConfig
  deno run --allow-all src/cli/index.ts -c generate-fsm-json -f apps/fsm-core-example/fsm/creditCheck/v01/machine.ts --output apps/fsm-core-example/fsm/creditCheck/v01
  deno run --allow-all src/cli/index.ts -c generate-async-logic -f apps/fsm-core-example/fsm
  deno run --allow-all src/cli/index.ts -c generate-async-logic -f apps/fsm-core-example/fsm --worker-sdk-protocol legacy
  deno run --allow-all src/cli/index.ts -c generate-async-logic -f apps/fsm-core-example/fsm/creditCheck/v01/fsm.json --output apps/fsm-core-example/fsm/creditCheck/v01
  deno run --allow-all src/cli/index.ts -c generate-sync-logic -f apps/fsm-core-example/fsm --lang typescript,python
  deno run --allow-all src/cli/index.ts -c generate-sync-logic -f apps/fsm-core-example/fsm/creditCheck/v01/fsm.json --output v01
  deno run --allow-all src/cli/index.ts -c create-async-logic -f apps/fsm-core-example --lang typescript --version v01 --name checkCreditScore
  deno run --allow-all src/cli/index.ts -c validate-sync-operation -f apps/fsm-core-example/fsm -w fsm
  deno run --allow-all src/cli/index.ts -c validate-async-operation -f apps/fsm-core-example/fsm --skip-dirs carVitals,creditCheck,taskMachineConfig
  deno run --allow-all src/cli/index.ts -c validate-async-operation -f apps/fsm-core-example/fsm --skip-dirs carVitals,creditCheck,taskMachineConfig --lang typescript
  deno run --allow-all src/cli/index.ts -c validate-async-operation -f apps/fsm-core-example/fsm --skip-dirs carVitals,creditCheck,taskMachineConfig --lang typescript,python
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

const workerSdkProtocol: WorkerSdkProtocol =
  (args["worker-sdk-protocol"] ?? "grpc") as WorkerSdkProtocol;
if (command === "generate-async-logic") {
  if (!WORKER_SDK_PROTOCOLS.includes(workerSdkProtocol)) {
    logger.error(
      "Invalid --worker-sdk-protocol value: {value}. Must be one of: {valid}",
      {
        value: args["worker-sdk-protocol"],
        valid: WORKER_SDK_PROTOCOLS.join(", "),
      },
    );
    printHelp();
    Deno.exit(1);
  }
}

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
  // generate-sync-logic templates are only maintained/tested for typescript
  // right now, even though OperationLang has other members. Reject the rest
  // explicitly rather than letting them scaffold un-vetted stubs.
  const unsupportedLangs = langs.filter((l) => l !== "typescript");
  if (unsupportedLangs.length > 0) {
    logger.error(
      "generate-sync-logic currently only supports --lang typescript. Unsupported: {unsupported}",
      { unsupported: unsupportedLangs.join(", ") },
    );
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

// Language for create-async-logic — exactly one language, required (no default).
const createAsyncLogicLang = args["lang"] as OperationLang | undefined;
if (command === "create-async-logic") {
  if (
    !createAsyncLogicLang || createAsyncLogicLang.includes(",") ||
    !isOperationLang(createAsyncLogicLang)
  ) {
    logger.error(
      "Invalid or missing --lang value: {value}. create-async-logic requires exactly one of: {valid}",
      {
        value: args["lang"] ?? "(none)",
        valid: SUPPORTED_OPERATION_LANGS.join(", "),
      },
    );
    printHelp();
    Deno.exit(1);
  }
}

const VALID_WORKFLOW_TYPES: string[] = [
  "fsm",
  "sharedAsyncOperation",
  "internalAsyncOperation",
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
  "load",
];

const missing: string[] = [];
if (!command) missing.push("--command");
if (!folder) missing.push("--folder");
if (command && needsWorkflowType.includes(command) && !workflowType) {
  missing.push("--workflow-type");
}
if (command === "create-async-logic") {
  if (!args["version"]) missing.push("--version");
  if (!args["name"]) missing.push("--name");
}

if (missing.length > 0) {
  logger.error("Missing required arguments: {missing}", {
    missing: missing.join(", "),
  });
  printHelp();
  Deno.exit(1);
}

// Commands that accept --folder pointing at a single fsm.json file
// (single-file mode) instead of only a plugin-root folder — both require
// --output for the version folder to scaffold into.
const SINGLE_FSM_JSON_FILE_COMMANDS = [
  "generate-sync-logic",
  "generate-async-logic",
];

// True when --folder points at a single fsm.json file rather than a
// plugin-root folder.
let folderIsFsmJsonFile = false;
// True when --folder points at a single machine.ts file (generate-fsm-json
// only) rather than a plugin-root folder.
let folderIsMachineTsFile = false;
if (folder) {
  try {
    const stat = await Deno.stat(folder);
    if (
      command && SINGLE_FSM_JSON_FILE_COMMANDS.includes(command) &&
      stat.isFile
    ) {
      if (!folder.endsWith(".json")) {
        logger.error(
          "--folder file must be an fsm.json file for {command}: {folder}",
          { command, folder },
        );
        Deno.exit(1);
      }
      folderIsFsmJsonFile = true;
    } else if (command === "generate-fsm-json" && stat.isFile) {
      if (!folder.endsWith(".ts")) {
        logger.error(
          "--folder is not a recognized type. Use a .ts file or a directory: {folder}",
          { folder },
        );
        Deno.exit(1);
      }
      folderIsMachineTsFile = true;
    } else if (command !== "generate-fsm-json" && !stat.isDirectory) {
      // generate-fsm-json accepts .ts/.json files too; all other commands require a directory
      logger.error("--folder is not a directory: {folder}", { folder });
      Deno.exit(1);
    }
  } catch {
    logger.error("--folder does not exist: {folder}", { folder });
    Deno.exit(1);
  }
}

if (folderIsFsmJsonFile && !args["output"]) {
  logger.error(
    "{command} requires --output <version-folder> when --folder is a single fsm.json file",
    { command },
  );
  printHelp();
  Deno.exit(1);
}

if (folderIsMachineTsFile && !args["output"]) {
  logger.error(
    "{command} requires --output <version-folder> when --folder is a single machine.ts file",
    { command },
  );
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
  // CLI talks to Postgres directly (no Supabase client), so useSupabase: false.
  return { db: new Pool({ connectionString: dbUrl }), useSupabase: false };
}

try {
  switch (command) {
    case "generate-fsm-json": {
      if (folderIsMachineTsFile) {
        const absPath = folder!.startsWith("/")
          ? folder!
          : `${Deno.cwd()}/${folder!}`;
        const absDir = absPath.substring(0, absPath.lastIndexOf("/"));
        const version = absDir.split("/").at(-1) ?? "v01";
        const versionFolderPath = resolvePluginRootAbsPath(args["output"]!);
        await generateFsmJSONFromMachineFile(
          absDir,
          version,
          args["show-recommendation"],
          versionFolderPath,
        );
      } else {
        await generateFsmJSONFromFolders(
          folder!,
          skipDirs,
          args["show-recommendation"],
        );
      }
      break;
    }
    case "generate-async-logic": {
      // Where worker-sdk-generated/ gets written -- the actor set to
      // aggregate always comes from the real FSM tree (--folder in folder
      // mode, fsm.json's own location in single-file mode), never from this.
      // No longer a separate CLI input: folder mode writes it one level
      // above --folder (the app root); single-fsm.json mode writes it to
      // --output.
      if (folderIsFsmJsonFile) {
        const versionFolderPath = resolvePluginRootAbsPath(args["output"]!);
        logger.info(
          "Writing worker-sdk-generated/ to {versionFolderPath}",
          { versionFolderPath },
        );
        await generateAsyncOperationLogicFromFsmJson(
          folder!,
          versionFolderPath,
          workerSdkProtocol,
          versionFolderPath,
        );
      } else {
        // One level above --folder (the app root), matching the on-disk
        // layout apps/fsm-core-example/ actually uses: worker-sdk-generated/
        // sits beside the fsm/ plugin-root folder, not inside it.
        const absFolder = resolvePluginRootAbsPath(folder!);
        const writeRootAbsPath = absFolder.substring(
          0,
          absFolder.lastIndexOf("/"),
        );
        logger.info(
          "Writing worker-sdk-generated/ to {writeRootAbsPath}",
          { writeRootAbsPath },
        );
        await generateAsyncOperationLogicFromFolders(
          folder!,
          skipDirs,
          workerSdkProtocol,
          writeRootAbsPath,
        );
      }
      break;
    }
    case "generate-sync-logic":
      if (folderIsFsmJsonFile) {
        const versionFolderPath = resolvePluginRootAbsPath(args["output"]!);
        await generateSyncOperationLogicFromFsmJson(
          folder!,
          versionFolderPath,
          langs,
        );
      } else {
        await generateSyncOperationLogicFromFolders(
          folder!,
          langs,
          skipDirs,
        );
      }
      break;
    case "create-async-logic":
      await createAsyncOperationLogic(
        folder!,
        createAsyncLogicLang!,
        args["version"]!,
        args["name"]!,
      );
      break;
    case "delete":
      await deleteFsmJSONFromFolders(folder!, skipDirs);
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
      logger.warn(
        "validate-async-operation is deprecated: it shells out to each actor's own language runtime and only works under the Deno-native CLI, never via the npm/npx build.",
      );
      const availableActors = await loadAvailableActors();
      await validateAsyncOperationFromFolders(
        folder!,
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
