import {
  FSM_DEFINITIONS,
  SYNC_OPERATION_REGISTRATIONS,
} from "../../test-apps/debug-only/sync-worker/typescript/aggregate-generated-sync-operation-registry.ts";
import { runFsmlet } from "./src/fsmlet/fsmlet.ts";

await runFsmlet(
  { connectionString: Deno.env.get("DATABASE_URL") ?? "" },
  SYNC_OPERATION_REGISTRATIONS,
  FSM_DEFINITIONS,
);
