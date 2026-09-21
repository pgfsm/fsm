// Self-owned bin: imports @pgfsm/sync-worker's library function directly
// rather than resolving and spawning that sibling package's own CLI file.
// fsmdev spawns this by name (relying on PATH — this package's own bins land
// in node_modules/.bin alongside its dependencies', the same way `npx -p
// @pgfsm/sync-worker -- fsmlet` already relies on for that package's bins),
// so it works whether @pgfsm/devstack lives in this monorepo (via `deno run
// --allow-all`) or is installed via npm. Only supports what fsmdev actually
// needs (a plugin-root folder, not the single fsm.json + --fsm-name/
// --fsm-version mode) — see fsmlet.ts in fsm-sync-worker-ts for the
// full-featured CLI this is scoped down from.
import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureWorkerLogger, runFsmlet } from "@pgfsm/sync-worker";
import type { FsmStartupConfig } from "@pgfsm/sync-worker";

dotenv.config({ path: ".env" });

const logger = getLogger(["@pgfsm/devstack", "run-fsmlet"]);
// configureWorkerLogger (not a bare configureLogging call) — it surfaces the
// worker/fsmlet/db/compiler/scheduler namespaces runFsmlet's internals
// actually log under; configuring only CATEGORY.worker silently dropped
// every fsmlet-namespaced log line (nothing printed, no error either).
await configureWorkerLogger();

const args = parseArgs(Deno.args, {
  string: ["fsm-folder-path", "db-url", "max-concurrency"],
  alias: {
    f: "fsm-folder-path",
    d: "db-url",
    m: "max-concurrency",
  },
});

const fsmFolderPath = args["fsm-folder-path"];
if (!fsmFolderPath) {
  logger.error("--fsm-folder-path is required");
  Deno.exit(1);
}

const DEFAULT_MAX_CONCURRENCY = 8;
const maxConcurrency = args["max-concurrency"]
  ? Number(args["max-concurrency"])
  : DEFAULT_MAX_CONCURRENCY;

const resolvedDbUrl = args["db-url"] ?? Deno.env.get("DATABASE_URL") ?? "";
if (!resolvedDbUrl) {
  logger.error(
    "DATABASE_URL is required (set in .env or pass --db-url)",
  );
  Deno.exit(1);
}

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
  logger.info(
    "Starting fsmlet with fsm-folder-path={path}, max-concurrency={max}",
    { path: fsmFolderPath, max: maxConcurrency },
  );
  await runFsmlet(
    { connectionString: resolvedDbUrl, max: poolMax },
    fsmConfig,
    { signal: controller.signal, maxConcurrency },
  );
  logger.info("Fsmlet stopped.");
} catch (err) {
  logger.error("Fsmlet failed: {error}", { error: err });
  Deno.exit(1);
}
