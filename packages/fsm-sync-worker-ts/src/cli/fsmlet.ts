import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureWorkerLogger } from "../logger.ts";
import { runFsmlet } from "../fsmlet/fsmlet.ts";
import type { FsmStartupConfig } from "../fsmlet/type.ts";

const logger = getLogger(["@pgfsm/fsmlet", "cli"]);
await configureWorkerLogger();

const args = parseArgs(Deno.args, {
  string: [
    "fsm-folder-path",
    "fsm-name",
    "fsm-version",
    "db-url",
    "max-concurrency",
    "fsmlet-id",
  ],
  boolean: ["help"],
  alias: {
    h: "help",
    f: "fsm-folder-path",
    N: "fsm-name",
    V: "fsm-version",
    d: "db-url",
    m: "max-concurrency",
    i: "fsmlet-id",
  },
});

function printHelp(): void {
  logger.info(`
fsmlet — FSM node agent (kubelet equivalent)

USAGE
  deno run --allow-all src/cli/fsmlet.ts -f <fsm-folder-path> [options]
  deno run --allow-all src/cli/fsmlet.ts -f <path>/fsm.json --fsm-name <name> --fsm-version <version> [options]

OPTIONS
  -f, --fsm-folder-path <path>   Absolute path to a FSM plugin-root folder, or to a single
                                  fsm.json file (required; a fsm.json file requires
                                  --fsm-name/--fsm-version, since there's no
                                  <fsmName>/<fsmVersion>/fsm.json folder structure to infer
                                  identity from)
  -N, --fsm-name <name>          FSM name, e.g. creditCheck (required when --fsm-folder-path
                                  is a single fsm.json file)
  -V, --fsm-version <version>    FSM version, e.g. v01 (required when --fsm-folder-path is a
                                  single fsm.json file)
  -d, --db-url <url>             Database connection URL (overrides DATABASE_URL from .env)
  -m, --max-concurrency <n>      Max FSM instances driven concurrently (default 8)
  -i, --fsmlet-id <id>           Stable fsmlet identity (default: random UUID per startup)
  -h, --help                     Show this help message

DESCRIPTION
  Registers itself in fsm_daemon_node, creates its private pgmq queues, then
  polls daemon_{id}_start and daemon_{id}_resume. The fsmscheduler routes
  messages here based on module availability and capacity. Sends heartbeats
  every 5 s so the scheduler can score this node. Deregisters cleanly on shutdown.
`);
}

if (args.help) {
  printHelp();
  Deno.exit(0);
}

const fsmFolderPath = args["fsm-folder-path"];
const fsmName = args["fsm-name"];
const fsmVersion = args["fsm-version"];
const dbUrl = args["db-url"];
const maxConcurrencyArg = args["max-concurrency"];
const fsmletId = args["fsmlet-id"] ?? Deno.env.get("FSMLET_ID");

const DEFAULT_MAX_CONCURRENCY = 8;
const maxConcurrency = maxConcurrencyArg
  ? Number(maxConcurrencyArg)
  : DEFAULT_MAX_CONCURRENCY;
if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
  logger.error("--max-concurrency must be a positive integer, got: {value}", {
    value: maxConcurrencyArg,
  });
  Deno.exit(1);
}

if (!fsmFolderPath) {
  logger.error("--fsm-folder-path is required");
  printHelp();
  Deno.exit(1);
}

let fsmFolderPathStat: Deno.FileInfo;
try {
  fsmFolderPathStat = await Deno.stat(fsmFolderPath);
} catch {
  logger.error("--fsm-folder-path does not exist: {path}", {
    path: fsmFolderPath,
  });
  Deno.exit(1);
}

// True when -f points at a single fsm.json file rather than a plugin-root
// folder — mirrors fsm-compiler-ts's `--folder <fsm.json>` single-file mode.
const fsmFolderPathIsFsmJsonFile = fsmFolderPathStat.isFile;

if (fsmFolderPathIsFsmJsonFile && !fsmFolderPath.endsWith("fsm.json")) {
  logger.error(
    "--fsm-folder-path file must be an fsm.json file: {path}",
    { path: fsmFolderPath },
  );
  Deno.exit(1);
}

if (fsmFolderPathIsFsmJsonFile && (!fsmName || !fsmVersion)) {
  logger.error(
    "--fsm-name and --fsm-version are required when --fsm-folder-path is a single fsm.json file",
  );
  printHelp();
  Deno.exit(1);
}

dotenv.config({ path: ".env" });
const resolvedDbUrl = dbUrl ?? Deno.env.get("DATABASE_URL") ?? "";

const controller = new AbortController();
let shutdownRequested = false;

const onSignal = () => {
  if (shutdownRequested) {
    logger.info("Force exit.");
    Deno.exit(0);
  }
  shutdownRequested = true;
  logger.info(
    "Shutdown requested — stopping fsmlet gracefully. Ctrl+C again to force exit...",
  );
  controller.abort();
};

Deno.addSignalListener("SIGINT", onSignal);
Deno.addSignalListener("SIGTERM", onSignal);

const fsmConfig: FsmStartupConfig = fsmFolderPathIsFsmJsonFile
  ? {
    fsm: {
      fsmJsonPath: fsmFolderPath,
      fsmName: fsmName!,
      fsmVersion: fsmVersion!,
    },
  }
  : { fsm: { folderPath: fsmFolderPath } };

// Size the shared pool for the fleet: one connection per concurrent worker,
// plus the dedicated LISTEN connection and a little headroom. KB-001 §3.4.
const poolMax = maxConcurrency + 4;

try {
  logger.info(
    "Starting fsmlet with fsm-folder-path={path}, fsm-name={name}, fsm-version={version}, db-url={url}, max-concurrency={max}, fsmlet-id={id}",
    {
      path: fsmFolderPath,
      name: fsmName,
      version: fsmVersion,
      url: resolvedDbUrl,
      max: maxConcurrency,
      id: fsmletId,
    },
  );
  await runFsmlet(
    { connectionString: resolvedDbUrl, max: poolMax },
    fsmConfig,
    { signal: controller.signal, maxConcurrency, fsmletId },
  );
  logger.info("Fsmlet stopped.");
} catch (err) {
  logger.error("Fsmlet failed: {error}", { error: err });
  Deno.exit(1);
}
