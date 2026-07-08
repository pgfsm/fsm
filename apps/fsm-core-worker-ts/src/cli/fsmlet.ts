import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureWorkerLogger } from "../logger.ts";
import { runFsmlet } from "../fsmlet/fsmlet.ts";
import type { FsmStartupConfig } from "../fsmlet/bootstrap-fsm-modules.ts";

const logger = getLogger(["@pgfsm/fsmlet", "cli"]);
await configureWorkerLogger();

const args = parseArgs(Deno.args, {
  string: ["fsm-folder-path", "db-url", "max-concurrency", "fsmlet-id"],
  boolean: ["help"],
  alias: {
    h: "help",
    f: "fsm-folder-path",
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

OPTIONS
  -f, --fsm-folder-path <path>   Absolute path to FSM folder (required)
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

try {
  await Deno.stat(fsmFolderPath);
} catch {
  logger.error("--fsm-folder-path does not exist: {path}", {
    path: fsmFolderPath,
  });
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

const fsmConfig: FsmStartupConfig = { fsm: { folderPath: fsmFolderPath } };

// Size the shared pool for the fleet: one connection per concurrent worker,
// plus the dedicated LISTEN connection and a little headroom. KB-001 §3.4.
const poolMax = maxConcurrency + 4;

try {
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
