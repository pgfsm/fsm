// AUTO-GENERATED from run-sync-worker.eta — do not edit directly.
// Run `deno task generate:templates` after editing the .eta source.
import { eta } from "../eta-instance.ts";

const compiled = eta.compile(
  '// Scaffolded by fsm-compiler-ts, yours to edit: `--overwrite generated-only`\n// (what @pgfsm/cli uses) never rewrites it once it exists.\nimport dotenv from "dotenv";\nimport { getLogger } from "@logtape/logtape";\nimport { CATEGORY, configureLogging, isTerminal } from "@pgfsm/logging";\nimport {\n  FSM_DEFINITIONS,\n  SYNC_OPERATION_REGISTRATIONS,\n} from "./sync-operation-registry-aggregate.generated.ts";\nimport { runFsmlet } from "@pgfsm/sync-worker";\n\ndotenv.config({ path: ".env" });\n\nconst level = isTerminal ? "debug" : "info";\nawait configureLogging({\n  levels: {\n    [CATEGORY.worker]: level,\n    [CATEGORY.fsmlet]: level,\n    [CATEGORY.db]: level,\n  },\n});\n\nconst logger = getLogger([CATEGORY.fsmlet]);\n\nconst controller = new AbortController();\nlet shutdownRequested = false;\n\nconst onSignal = () => {\n  if (shutdownRequested) {\n    logger.info("Force exit.");\n    Deno.exit(0);\n  }\n  shutdownRequested = true;\n  logger.info(\n    "Shutdown requested — stopping gracefully. Ctrl+C again to force exit...",\n  );\n  controller.abort();\n};\n\nDeno.addSignalListener("SIGINT", onSignal);\nDeno.addSignalListener("SIGTERM", onSignal);\n\nawait runFsmlet(\n  { connectionString: Deno.env.get("DATABASE_URL") ?? "" },\n  SYNC_OPERATION_REGISTRATIONS,\n  // Refuses to start unless the database holds exactly these fsm.json\n  // definitions; load them first with `pgfsmctl fsm load` (npm run db:load).\n  FSM_DEFINITIONS,\n  { signal: controller.signal },\n);\n',
);

export const render: (input: unknown) => string = (input) =>
  compiled.call(eta, input as object);
