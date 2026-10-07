// Scaffolded by fsm-compiler-ts, yours to edit: `--overwrite generated-only`
// (what @pgfsm/cli uses) never rewrites it once it exists.
import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { CATEGORY, configureLogging, isTerminal } from "@pgfsm/logging";
import {
  FSM_DEFINITIONS,
  SYNC_OPERATION_REGISTRATIONS,
} from "./sync-operation-registry-aggregate.generated.ts";
import { runFsmlet } from "@pgfsm/sync-worker";

dotenv.config({ path: ".env" });

const level = isTerminal ? "debug" : "info";
await configureLogging({
  levels: {
    [CATEGORY.worker]: level,
    [CATEGORY.fsmlet]: level,
    [CATEGORY.db]: level,
  },
});

const logger = getLogger([CATEGORY.fsmlet]);

const controller = new AbortController();
let shutdownRequested = false;

const onSignal = () => {
  if (shutdownRequested) {
    logger.info("Force exit.");
    Deno.exit(0);
  }
  shutdownRequested = true;
  logger.info(
    "Shutdown requested — stopping gracefully. Ctrl+C again to force exit...",
  );
  controller.abort();
};

Deno.addSignalListener("SIGINT", onSignal);
Deno.addSignalListener("SIGTERM", onSignal);

await runFsmlet(
  { connectionString: Deno.env.get("DATABASE_URL") ?? "" },
  SYNC_OPERATION_REGISTRATIONS,
  // Refuses to start unless the database holds exactly these fsm.json
  // definitions; load them first with `pgfsmctl fsm load` (npm run db:load).
  FSM_DEFINITIONS,
  { signal: controller.signal },
);
