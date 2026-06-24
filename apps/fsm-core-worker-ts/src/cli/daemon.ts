import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";

import { configureWorkerLogger } from "../logger.ts";
import { runFsmDispatchDaemon } from "../run-fsm-dispatch-daemon.ts";
import type { FsmStartupConfig } from "../bootstrap-fsm-modules.ts";

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
  console.log(`
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
  console.error(`Error: --max-concurrency must be a positive integer, got "${maxConcurrencyArg}".`);
  Deno.exit(1);
}

if (!fsmFolderPath) {
  console.error("Error: --fsm-folder-path is required\n");
  printHelp();
  Deno.exit(1);
}

try {
  await Deno.stat(fsmFolderPath);
} catch {
  console.error(`Error: --fsm-folder-path "${fsmFolderPath}" does not exist.`);
  Deno.exit(1);
}

dotenv.config({ path: ".env" });
await configureWorkerLogger();
const resolvedDbUrl = dbUrl ?? Deno.env.get("DATABASE_URL") ?? "";

const controller = new AbortController();
let shutdownRequested = false;

const onSignal = () => {
  if (shutdownRequested) {
    console.log("\nForce exit.");
    Deno.exit(0);
  }
  shutdownRequested = true;
  console.log("\nShutdown requested — stopping daemon gracefully. Ctrl+C again to force exit...");
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
  console.log("\nDaemon stopped.");
} catch (err) {
  console.error("\nDaemon failed:", err);
  Deno.exit(1);
}
