import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureWorkerLogger } from "../logger.ts";
import { runFsmDispatchDaemon } from "../run-fsm-dispatch-daemon.ts";
import type { FsmStartupConfig } from "../bootstrap-fsm-modules.ts";

const logger = getLogger(["@pgfsm/worker", "daemon"]);
await configureWorkerLogger();

const args = parseArgs(Deno.args, {
  string: ["fsm-folder-path", "db-url", "max-concurrency"],
  boolean: ["help"],
  alias: {
    h: "help",
    f: "fsm-folder-path",
    d: "db-url",
    m: "max-concurrency",
  },
});

function printHelp(): void {
  logger.info(`
fsm-worker daemon — FSM dispatcher daemon

USAGE
  deno run --allow-all src/cli/daemon.ts -f <fsm-folder-path> [options]

OPTIONS
  -f, --fsm-folder-path <path>   Absolute path to FSM folder (required)
  -d, --db-url <url>             Database connection URL (overrides DATABASE_URL from .env)
  -m, --max-concurrency <n>      Max FSM instances driven concurrently (default 8)
  -h, --help                     Show this help message

DESCRIPTION
  Bootstraps FSM modules, sets up the worker-stop listener, then polls
  master_worker_dispatch_queue and drives each new FSM instance in-process
  on a bounded standing fleet (KB-001 §3.1). One shared pg Pool serves the
  whole fleet, so connection count scales with --max-concurrency, not with
  the number of live instances.
`);
}

if (args.help) {
  printHelp();
  Deno.exit(0);
}

const fsmFolderPath = args["fsm-folder-path"];
const dbUrl = args["db-url"];
const maxConcurrencyArg = args["max-concurrency"];

const DEFAULT_MAX_CONCURRENCY = 8;
const maxConcurrency = maxConcurrencyArg ? Number(maxConcurrencyArg) : DEFAULT_MAX_CONCURRENCY;
if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
  logger.error("--max-concurrency must be a positive integer, got: {value}", { value: maxConcurrencyArg });
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
  logger.error("--fsm-folder-path does not exist: {path}", { path: fsmFolderPath });
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
  logger.info("Shutdown requested — stopping daemon gracefully. Ctrl+C again to force exit...");
  controller.abort();
};

Deno.addSignalListener("SIGINT", onSignal);
Deno.addSignalListener("SIGTERM", onSignal);

const fsmConfig: FsmStartupConfig = { fsm: { folderPath: fsmFolderPath } };

// Size the shared pool for the fleet: one connection per concurrent worker,
// plus the dedicated LISTEN connection (pgListenerForWorkerStopEvent) and a
// little headroom. KB-001 §3.4 — keep this small and front it with a pooler.
const poolMax = maxConcurrency + 4;

try {
  await runFsmDispatchDaemon(
    { connectionString: resolvedDbUrl, max: poolMax },
    fsmConfig,
    { signal: controller.signal, maxConcurrency },
  );
  logger.info("Daemon stopped.");
} catch (err) {
  logger.error("Daemon failed: {error}", { error: err });
  Deno.exit(1);
}
