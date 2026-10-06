import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureCompilerLogger } from "../logger.ts";
import { CLI_INVOCATION } from "./invocation.ts";
import { PACKAGE_VERSION } from "./version.ts";
import {
  createAsyncOperationLogic,
  deleteFsmJSONFromFolders,
  generateAll,
  generateAsyncOperationLogicFromFolders,
  generateAsyncOperationLogicFromFsmJson,
  generateFsmJSONFromFolders,
  generateFsmJSONIntoFsmDir,
  generateSyncOperationLogicFromFolders,
  generateSyncOperationLogicFromFsmJson,
  isOperationLang,
  loadFsmJSONFromFolders,
  SUPPORTED_OPERATION_LANGS,
  validateAsyncOperationFromFolders,
  validateSyncOperationFromFolders,
  validateSyncOperationFromFsmJson,
  withWritePolicy,
} from "../index.ts";
import type {
  FileWriteEvent,
  OperationLang,
  OverwriteMode,
  WritePolicyOptions,
} from "../index.ts";

const logger = getLogger(["@pgfsm/compiler", "cli"]);
await configureCompilerLogger();

const args = parseArgs(Deno.args, {
  string: [
    "command",
    "folder",
    "skip-dirs",
    "db-url",
    "lang",
    "output",
    "fsm-name",
    "fsm-version",
    "function-name",
    "function-version",
    "project-name",
    "overwrite",
  ],
  boolean: [
    "help",
    "version",
    "show-recommendation",
    "force",
    "include-workers",
  ],
  alias: {
    h: "help",
    c: "command",
    f: "folder",
    r: "show-recommendation",
    s: "skip-dirs",
    d: "db-url",
    l: "lang",
    o: "output",
    N: "fsm-name",
    v: "version",
    V: "fsm-version",
    n: "function-name",
    F: "function-version",
  },
});

if (args.version) {
  // Bare, undecorated output (no logger timestamp/category prefix) so
  // `$(fsm-compiler --version)` stays script-friendly, matching every other
  // CLI's --version convention.
  console.log(PACKAGE_VERSION);
  Deno.exit(0);
}

function printHelp(): void {
  logger.info(`
fsm-compiler — FSM JSON compiler CLI

USAGE
  ${CLI_INVOCATION} -c <command> -f <folder> [options]

COMMANDS
  generate-fsm-json                   Generate fsm.json + xstate-fsm.json from a plugin-root folder (written in place, next to each machine.ts) or a single machine.ts file (--fsm-name/--fsm-version required; written to {cwd}/fsm/<fsmName>/<fsmVersion>/ only if compilation succeeds — machine.ts itself is not copied)
  generate-async-logic                Scaffold actor stubs (per invoke object's asyncOperationLanguage), for a plugin-root folder or a single fsm.json (--fsm-name/--fsm-version required for a single fsm.json). Always written to {cwd}/async-worker/<lang>/<fsmName>/<fsmVersion>/, independent of --folder's own location — --output is not used. The aggregate registry/worker SDK (TypeScript: run-async-worker.ts + deno.json importing @pgfsm/async-worker-sdk; Python: run_async_worker.py + pyproject.toml pinning pgfsm-async-worker-sdk; Rust: src/main.rs + Cargo.toml depending on the pgfsm-async-worker-sdk crate; Go: main.go + go.mod requiring the fsm-async-worker-sdk-go module; actor-registry-aggregate.generated.ts, etc.) are written to {cwd}/async-worker/<lang>/
  generate-sync-logic                 Scaffold action/guard/delay stubs in --lang language(s), for a plugin-root folder or a single fsm.json (--fsm-name/--fsm-version required for a single fsm.json). Always written to {cwd}/sync-worker/typescript/<fsmName>/<fsmVersion>/, independent of --folder's own location — --output is not used. Once the aggregate registry exists, also writes a runnable run-sync-worker.ts + deno.json at {cwd}/sync-worker/typescript/ — --project-name sets that deno.json's own name (defaults to a random sync-worker-<8 hex chars> otherwise)
  generate-all                        Run generate-fsm-json, then generate-async-logic, then generate-sync-logic in sequence, for a folder, a single machine.ts file, or a single fsm.json file. Always writes {cwd}/async-worker/ and {cwd}/sync-worker/ (run it from your app root) — --output is not accepted. A single machine.ts compiles into {cwd}/fsm/<fsmName>/<fsmVersion>/ like generate-fsm-json; a single fsm.json skips generate-fsm-json and is copied there. Either single-file mode requires --fsm-name/--fsm-version. In folder mode, one step's partial failure across some FSMs doesn't block the next step from running for the rest
  create-async-logic                  Scaffold a single actor stub in the shared, non-FSM-scoped async-op pool (--function-name/--function-version required; no --folder — always anchored at {cwd}). Always written to {cwd}/async-worker/<lang>/sharedAsyncOperation/<functionVersion>/actors/<functionName>/<functionName>.ext. Also rewrites that language's registry at {cwd}/async-worker/<lang>/sharedAsyncOperation/<functionVersion>/actor-registry.generated.ext (scoped to that function-version's own actors), and refreshes that language's FSM-scoped aggregate registry too ({cwd}/async-worker/<lang>/actor-registry-aggregate.generated.ext, or Go's {cwd}/async-worker/go/actor-registry-aggregate-generated/) — but not the worker SDK (run-async-worker.ts/run_async_worker.py/etc), which still needs a generate-async-logic/generate-all run
  delete                              Delete generated fsm.json / xstate-fsm.json files (version folders without a machine.ts are kept). {cwd}/sync-worker/ and {cwd}/async-worker/ stub folders are kept unless --include-workers is passed
  validate-sync-operation             Validate sync operation logic (actions/guards/delays) for a plugin-root folder or a single fsm.json (--fsm-name/--fsm-version required for a single fsm.json)
  validate-async-operation            [DEPRECATED] Validate async operation logic (actors) for a sharedAsyncOperation folder — unsupported under the npm/npx build, requires the Deno-native CLI
  load                                [DEPRECATED] Load FSM JSON into the database — use 'pgfsmctl fsm load <folder>' (@pgfsm/ctl) instead

OPTIONS
  -c, --command <command>             Command to run (required)
  -f, --folder <folder>               Path to FSM folder, .ts file, or fsm.json file (required for every command except create-async-logic, which takes no --folder at all; a .ts file is accepted for generate-fsm-json/generate-all only, and requires --fsm-name/--fsm-version; a fsm.json file is accepted for generate-sync-logic/generate-async-logic/generate-all/validate-sync-operation only, and requires --fsm-name/--fsm-version)
  -l, --lang <langs>                  Comma-separated language(s): typescript, python, rust, go. For generate-sync-logic/generate-all defaults to typescript; for validate-async-operation defaults to all languages; for create-async-logic a single language is required
  -n, --function-name <name>           Function name, e.g. checkCreditScore (create-async-logic only, required — these actors have no owning FSM, so this is unrelated to --fsm-name)
  -F, --function-version <version>     Function version folder name, e.g. v01 (create-async-logic only, required — unrelated to --fsm-version)
  -N, --fsm-name <name>                FSM name, e.g. creditCheck (generate-sync-logic/generate-async-logic/validate-sync-operation/generate-all: required when --folder is a single fsm.json file; generate-fsm-json/generate-all: required when --folder is a single machine.ts file)
  -V, --fsm-version <version>          FSM version folder name, e.g. v01 (same commands and cases as --fsm-name; for a machine.ts it also fills in missing asyncOperationVersion)
  --project-name <name>                Name for the generated run-sync-worker.ts's deno.json (generate-sync-logic only, optional — defaults to a random sync-worker-<8 hex chars> when omitted)
  --overwrite <mode>                   all (default) rewrites every file; generated-only keeps existing scaffolded files — action/guard/delay and actor stubs, per-actor go.mod, the TS/Python/Rust worker entry files and their deno.json/pyproject.toml/Cargo.toml, .gitignore — and reports stub exports they're missing. Registries, manifests, fsm.json and the Go worker module are always rewritten
  --force                              Overwrite {cwd}/fsm/<fsmName>/<fsmVersion>/fsm.json even when it belongs to a different machine id (generate-fsm-json/generate-all single-file mode only)
  --include-workers                    Also remove each FSM version's {cwd}/sync-worker/typescript/<fsmName>/<fsmVersion>/ and {cwd}/async-worker/<lang>/<fsmName>/<fsmVersion>/ folders, including implemented stubs (delete only)
  -r, --show-recommendation           Validate generated fsm.json against schema and show errors (generate-fsm-json/generate-all only)
  -s, --skip-dirs <dirs>              Comma-separated list of subdirectory names to skip
  -d, --db-url <url>                  PostgreSQL connection string (overrides DATABASE_URL env var)
  -v, --version                       Print @pgfsm/compiler's version and exit
  -h, --help                          Show this help message

ENVIRONMENT
  DATABASE_URL    Fallback connection string for load. Ignored if --db-url is provided.

EXAMPLES
  ${CLI_INVOCATION} -c generate-fsm-json -f apps/fsm-core-example/fsm
  ${CLI_INVOCATION} -c generate-fsm-json -f apps/fsm-core-example/fsm --skip-dirs carVitals,taskMachineConfig
  cd my-app && ${CLI_INVOCATION} -c generate-fsm-json -f ~/designs/checkout/machine.ts --fsm-name checkout --fsm-version v01
  ${CLI_INVOCATION} -c generate-async-logic -f apps/fsm-core-example/fsm
  ${CLI_INVOCATION} -c generate-async-logic -f apps/fsm-core-example/fsm/creditCheck/v01/fsm.json --fsm-name creditCheck --fsm-version v01
  ${CLI_INVOCATION} -c generate-sync-logic -f apps/fsm-core-example/fsm --lang typescript,python
  ${CLI_INVOCATION} -c generate-sync-logic -f apps/fsm-core-example/fsm/creditCheck/v01/fsm.json --fsm-name creditCheck --fsm-version v01
  cd apps/fsm-core-example && ${CLI_INVOCATION} -c generate-all -f fsm
  cd apps/fsm-core-example && ${CLI_INVOCATION} -c generate-all -f fsm/creditCheck/v01/machine.ts --fsm-name creditCheck --fsm-version v01
  cd apps/fsm-core-example && ${CLI_INVOCATION} -c generate-all -f fsm/creditCheck/v01/fsm.json --fsm-name creditCheck --fsm-version v01
  cd my-app && ${CLI_INVOCATION} -c generate-all -f ~/Downloads/checkout.json --fsm-name checkout --fsm-version v01
  ${CLI_INVOCATION} -c create-async-logic --lang typescript --function-name checkCreditScore --function-version v01
  ${CLI_INVOCATION} -c validate-sync-operation -f apps/fsm-core-example/fsm
  ${CLI_INVOCATION} -c validate-sync-operation -f apps/fsm-core-example/fsm/creditCheck/v01/fsm.json --fsm-name creditCheck --fsm-version v01
  ${CLI_INVOCATION} -c validate-async-operation -f apps/fsm-core-example/fsm --skip-dirs carVitals,creditCheck,taskMachineConfig
  ${CLI_INVOCATION} -c validate-async-operation -f apps/fsm-core-example/fsm --skip-dirs carVitals,creditCheck,taskMachineConfig --lang typescript
  ${CLI_INVOCATION} -c validate-async-operation -f apps/fsm-core-example/fsm --skip-dirs carVitals,creditCheck,taskMachineConfig --lang typescript,python
`);
}

if (args.help || Deno.args.length === 0) {
  printHelp();
  Deno.exit(0);
}

const command = args["command"];
const folder = args["folder"];
const skipDirs = args["skip-dirs"]
  ? args["skip-dirs"].split(",").map((s: string) => s.trim())
  : [];

// Languages for generate-sync-logic (comma-separated). Defaults to typescript.
const langs: OperationLang[] =
  (args["lang"]
    ? args["lang"].split(",").map((s: string) => s.trim()).filter(Boolean)
    : ["typescript"]) as OperationLang[];
if (command === "generate-sync-logic" || command === "generate-all") {
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
      "{command} currently only supports --lang typescript for sync-logic generation. Unsupported: {unsupported}",
      { command, unsupported: unsupportedLangs.join(", ") },
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

const missing: string[] = [];
if (!command) missing.push("--command");
// create-async-logic takes no --folder at all -- it's always anchored at
// Deno.cwd(), like generate-sync-logic/generate-async-logic (#305/#307).
if (!folder && command !== "create-async-logic") missing.push("--folder");
if (command === "create-async-logic") {
  if (!args["function-version"]) missing.push("--function-version");
  if (!args["function-name"]) missing.push("--function-name");
}

if (missing.length > 0) {
  logger.error("Missing required arguments: {missing}", {
    missing: missing.join(", "),
  });
  printHelp();
  Deno.exit(1);
}

// Commands that accept --folder pointing at a single fsm.json file
// (single-file mode) instead of only a plugin-root folder. generate-all
// accepts single-file --folder too, but does its own mode detection
// internally (see ../generate-all.ts) rather than
// through this shared gate, since it must also accept a single machine.ts
// file — a mix no other command needs.
const SINGLE_FSM_JSON_FILE_COMMANDS = [
  "generate-sync-logic",
  "generate-async-logic",
  "validate-sync-operation",
];

// None of SINGLE_FSM_JSON_FILE_COMMANDS require --output as of #307:
// generate-sync-logic and generate-async-logic both need
// --fsm-name/--fsm-version instead (checked below), since single-file mode
// has no <fsmName>/<fsmVersion>/fsm.json folder structure to infer identity
// from -- both always write to
// {cwd}/<sync|async>-worker/<lang>/<fsmName>/<fsmVersion>/ regardless of
// --folder's own location, so neither has a version folder to accept as
// --output in the first place. validate-sync-operation writes nothing and
// never took --output. Commands that need --fsm-name/--fsm-version instead:
const SINGLE_FSM_JSON_FILE_COMMANDS_REQUIRING_FSM_IDENTITY = [
  "generate-sync-logic",
  "generate-async-logic",
  "validate-sync-operation",
];

// Commands that accept --folder pointing at a single machine.ts file
// (single-file mode) instead of only a plugin-root folder — requires
// --fsm-name/--fsm-version, which name the {cwd}/fsm/ folder written into.
const MACHINE_TS_FILE_COMMANDS = [
  "generate-fsm-json",
];

// True when --folder points at a single fsm.json file rather than a
// plugin-root folder.
let folderIsFsmJsonFile = false;
// True when --folder points at a single machine.ts file rather than a
// plugin-root folder.
let folderIsMachineTsFile = false;
// generate-all does its own --folder existence/type validation
// (see generateAll in ../generate-all.ts) since it accepts a plugin-root
// folder, a single machine.ts file, or a single fsm.json file — a mix no
// other command needs, so it skips this shared gate entirely.
// create-async-logic doesn't take --folder at all (see above), so it's
// excluded too rather than validating a flag it never reads.
if (folder && command !== "generate-all" && command !== "create-async-logic") {
  try {
    const stat = await Deno.stat(folder);
    // MACHINE_TS_FILE_COMMANDS and SINGLE_FSM_JSON_FILE_COMMANDS are
    // disjoint (generate-all — the one command that accepted both — does its
    // own detection now, see the guard above), so a command is never in both.
    if (
      command && SINGLE_FSM_JSON_FILE_COMMANDS.includes(command) &&
      stat.isFile && folder.endsWith(".json")
    ) {
      folderIsFsmJsonFile = true;
    } else if (
      command && MACHINE_TS_FILE_COMMANDS.includes(command) && stat.isFile &&
      folder.endsWith(".ts")
    ) {
      folderIsMachineTsFile = true;
    } else if (
      command && SINGLE_FSM_JSON_FILE_COMMANDS.includes(command) && stat.isFile
    ) {
      logger.error(
        "--folder file must be an fsm.json file for {command}: {folder}",
        { command, folder },
      );
      Deno.exit(1);
    } else if (
      command && MACHINE_TS_FILE_COMMANDS.includes(command) && stat.isFile
    ) {
      logger.error(
        "--folder is not a recognized type. Use a .ts file or a directory: {folder}",
        { folder },
      );
      Deno.exit(1);
    } else if (
      command && !MACHINE_TS_FILE_COMMANDS.includes(command) &&
      !SINGLE_FSM_JSON_FILE_COMMANDS.includes(command) &&
      !stat.isDirectory
    ) {
      // generate-fsm-json/generate-sync-logic/generate-async-logic/
      // validate-sync-operation accept .ts/.json files too; every other
      // command reaching here requires a directory (generate-all never
      // reaches this block at all — see the guard above)
      logger.error("--folder is not a directory: {folder}", { folder });
      Deno.exit(1);
    }
  } catch {
    logger.error("--folder does not exist: {folder}", { folder });
    Deno.exit(1);
  }
}

if (
  folderIsFsmJsonFile &&
  SINGLE_FSM_JSON_FILE_COMMANDS_REQUIRING_FSM_IDENTITY.includes(command!) &&
  (!args["fsm-name"] || !args["fsm-version"])
) {
  logger.error(
    "{command} requires --fsm-name and --fsm-version when --folder is a single fsm.json file",
    { command },
  );
  printHelp();
  Deno.exit(1);
}

// --output is gone from every command (#372 generate-all, #376
// generate-fsm-json). It's still declared in parseArgs only so an old
// invocation fails loudly here instead of silently writing somewhere else.
if (args["output"]) {
  logger.error(
    "--output is no longer supported: everything is written under the current directory ({cwd}/fsm/<fsmName>/<fsmVersion>/, {cwd}/sync-worker/, {cwd}/async-worker/). Run from your app root and pass --fsm-name/--fsm-version for a single file.",
  );
  printHelp();
  Deno.exit(1);
}

// generate-fsm-json/generate-all single-file modes need an explicit
// identity, same as SINGLE_FSM_JSON_FILE_COMMANDS_REQUIRING_FSM_IDENTITY --
// never guessed from the file's parent folders (#372/#376). The library
// functions re-check this; checking here as well gives the CLI its usual
// help output.
if (
  (command === "generate-all" && folder &&
      (folder.endsWith(".json") || folder.endsWith(".ts")) ||
    folderIsMachineTsFile) &&
  (!args["fsm-name"] || !args["fsm-version"])
) {
  logger.error(
    "{command} requires --fsm-name and --fsm-version when --folder is a single {kind} file",
    { command, kind: folder!.endsWith(".json") ? "fsm.json" : "machine.ts" },
  );
  printHelp();
  Deno.exit(1);
}

const OVERWRITE_MODES: OverwriteMode[] = ["all", "generated-only"];
const overwriteArg = args["overwrite"] ?? "all";
if (!(OVERWRITE_MODES as string[]).includes(overwriteArg)) {
  logger.error("Invalid --overwrite value: {value}. Must be one of: {valid}", {
    value: overwriteArg,
    valid: OVERWRITE_MODES.join(", "),
  });
  printHelp();
  Deno.exit(1);
}

// #381: --overwrite generated-only leaves existing scaffolded files (stubs,
// worker entry files, manifests developers add dependencies to) untouched.
// Kept files are always reported, since a kept stub module may now be
// missing exports the FSM needs.
const writeCounts = { created: 0, regenerated: 0, kept: 0 };
const writePolicy: WritePolicyOptions = {
  overwrite: overwriteArg as OverwriteMode,
  onFileWrite: (event: FileWriteEvent) => {
    writeCounts[event.action]++;
    if (event.action !== "kept") return;
    if (event.missingNames) {
      logger.warn(
        "Kept {path} (yours), but it doesn't define {missing} -- add them by hand",
        { path: event.path, missing: event.missingNames.join(", ") },
      );
    } else {
      logger.info("Kept {path} (yours)", { path: event.path });
    }
  },
};

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
  await withWritePolicy(writePolicy, async () => {
    switch (command) {
      case "generate-fsm-json": {
        if (folderIsMachineTsFile) {
          // {cwd}/fsm/<fsmName>/<fsmVersion>/ (#376), like every other
          // single-file write in this CLI.
          await generateFsmJSONIntoFsmDir({
            machineTsPath: folder!,
            fsmName: args["fsm-name"]!,
            fsmVersion: args["fsm-version"]!,
            writeRootAbsPath: Deno.cwd(),
            showRecommendation: args["show-recommendation"],
            force: args["force"],
          });
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
        // Always anchored at Deno.cwd() -- {cwd}/async-worker/<lang>/
        // <fsmName>/<fsmVersion>/ -- independent of --folder's own location, in
        // both modes (the actor set to aggregate still always comes from the
        // real FSM tree: --folder in folder mode, fsm.json's own location in
        // single-file mode -- never from writeRootAbsPath).
        if (folderIsFsmJsonFile) {
          await generateAsyncOperationLogicFromFsmJson(
            folder!,
            Deno.cwd(),
            args["fsm-name"]!,
            args["fsm-version"]!,
          );
        } else {
          await generateAsyncOperationLogicFromFolders(
            folder!,
            skipDirs,
            Deno.cwd(),
          );
        }
        break;
      }
      case "generate-sync-logic":
        // Always anchored at Deno.cwd() -- {cwd}/sync-worker/typescript/
        // <fsmName>/<fsmVersion>/ -- independent of --folder's own location, in
        // both modes.
        if (folderIsFsmJsonFile) {
          await generateSyncOperationLogicFromFsmJson(
            folder!,
            Deno.cwd(),
            args["fsm-name"]!,
            args["fsm-version"]!,
            langs,
            args["project-name"],
          );
        } else {
          await generateSyncOperationLogicFromFolders(
            folder!,
            langs,
            skipDirs,
            Deno.cwd(),
            args["project-name"],
          );
        }
        break;
      case "generate-all": {
        // Always anchored at Deno.cwd() in every mode, like
        // generate-sync-logic/generate-async-logic (#372).
        await generateAll({
          folder: folder!,
          writeRootAbsPath: Deno.cwd(),
          fsmName: args["fsm-name"],
          fsmVersion: args["fsm-version"],
          force: args["force"],
          skipDirs,
          showRecommendation: args["show-recommendation"],
          langs,
        });
        break;
      }
      case "create-async-logic":
        await createAsyncOperationLogic(
          Deno.cwd(),
          createAsyncLogicLang!,
          args["function-version"]!,
          args["function-name"]!,
        );
        break;
      case "delete":
        await deleteFsmJSONFromFolders(folder!, skipDirs, {
          includeWorkers: args["include-workers"],
        });
        break;
      case "validate-sync-operation": {
        if (folderIsFsmJsonFile) {
          await validateSyncOperationFromFsmJson(
            folder!,
            args["fsm-name"]!,
            args["fsm-version"]!,
          );
        } else {
          await validateSyncOperationFromFolders(
            folder!,
            skipDirs,
          );
        }
        break;
      }
      case "validate-async-operation": {
        logger.warn(
          "validate-async-operation is deprecated: it shells out to each actor's own language runtime and only works under the Deno-native CLI, never via the npm/npx build.",
        );
        await validateAsyncOperationFromFolders(
          folder!,
          skipDirs,
          [],
          validateLangs,
        );
        break;
      }
      case "load": {
        logger.warn(
          "load is deprecated: use `pgfsmctl fsm load <folder>` from @pgfsm/ctl instead (SPEC-006). It will be removed in a later release.",
        );
        const deps = await buildDeps(args["db-url"]);
        await loadFsmJSONFromFolders(folder!, skipDirs, deps);
        break;
      }
      default:
        logger.error("Unknown command: {command}", { command });
        printHelp();
        Deno.exit(1);
    }
  });

  if (writeCounts.kept > 0) {
    logger.info(
      "Files: {created} created, {regenerated} regenerated, {kept} kept.",
      writeCounts,
    );
  }
  logger.info("Command {command} completed successfully.", { command });
} catch (err) {
  logger.error("Command {command} failed: {error}", { command, error: err });
  Deno.exit(1);
}
