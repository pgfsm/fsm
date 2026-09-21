// Self-owned bin: imports @pgfsm/async-worker's library function directly
// rather than resolving and spawning that sibling package's own CLI file.
// fsmdev spawns this by name (relying on PATH — this package's own bins land
// in node_modules/.bin alongside its dependencies', the same way `npx -p
// @pgfsm/sync-worker -- fsmlet` already relies on for that package's bins),
// so it works whether @pgfsm/devstack lives in this monorepo (via `deno run
// --allow-all`) or is installed via npm. Only supports what fsmdev actually
// needs (poll loop always on, no single-file fsm.json mode) — see
// async-operation-worker-gateway.ts in fsm-core-async-op-worker for the
// full-featured CLI this is scoped down from.
import { parseArgs } from "@std/cli/parse-args";
import dotenv from "dotenv";
import { Pool } from "pg";
import { getLogger } from "@logtape/logtape";
import { CATEGORY, configureLogging, isTerminal } from "@pgfsm/logging";
import type { DBDeps } from "@pgfsm/db";
import { startActivityGatewayServer } from "@pgfsm/async-worker";

dotenv.config({ path: ".env" });

const logger = getLogger(["@pgfsm/devstack", "run-gateway"]);
await configureLogging({
  levels: { [CATEGORY.worker]: isTerminal ? "debug" : "info" },
});

const args = parseArgs(Deno.args, {
  string: ["bind", "sidecar-socket", "poll-interval-ms", "db-url"],
  boolean: ["ensure-queue-on-register"],
  alias: {
    b: "bind",
    s: "sidecar-socket",
    d: "db-url",
  },
});

const bindTarget = args.bind ?? "unix:/tmp/pgfsm-activity-gateway.sock";
const sidecarSocketPath = args["sidecar-socket"] ??
  "/tmp/pgfsm-activity-gateway-workers.sock";
const pollIntervalArg = args["poll-interval-ms"];
const pollIntervalMs = pollIntervalArg ? Number(pollIntervalArg) : undefined;
const ensureQueueOnRegisterEnabled = !!args["ensure-queue-on-register"];

const resolvedDbUrl = args["db-url"] ?? Deno.env.get("DATABASE_URL") ?? "";
if (!resolvedDbUrl) {
  logger.error(
    "DATABASE_URL is required (set in .env or pass --db-url)",
  );
  Deno.exit(1);
}

const dbPool = new Pool({ connectionString: resolvedDbUrl });
const deps: DBDeps = { db: dbPool, useSupabase: false };

const controller = new AbortController();
let shutdownRequested = false;
const onSignal = () => {
  if (shutdownRequested) {
    logger.info("Force exit.");
    Deno.exit(0);
  }
  shutdownRequested = true;
  logger.info(
    "Shutdown requested — stopping activity gateway gracefully. Ctrl+C again to force exit...",
  );
  controller.abort();
};
Deno.addSignalListener("SIGINT", onSignal);
Deno.addSignalListener("SIGTERM", onSignal);

try {
  logger.info(
    "Starting activity gateway: bind={bind}, sidecar-socket={socket}",
    { bind: bindTarget, socket: sidecarSocketPath },
  );
  await startActivityGatewayServer({
    bindTarget,
    sidecarSocketPath,
    signal: controller.signal,
    asyncOpPollLoop: { deps, intervalMs: pollIntervalMs },
    ensureQueueOnRegister: ensureQueueOnRegisterEnabled ? { deps } : undefined,
  });
  logger.info("Activity gateway stopped.");
} catch (err) {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.error("Activity gateway failed: {error}", { error: msg });
  Deno.exit(1);
} finally {
  await dbPool.end();
}
