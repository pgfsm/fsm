import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureCompilerLogger } from "./logger.ts";
import { loadFsmJSONFromFolders } from "./load-fsm-json.ts";
import { Pool } from "pg";

dotenv.config({ path: "./../../.env" });
const logger = getLogger(["@pgfsm/compiler", "test"]);
await configureCompilerLogger();

const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });

(async () => {
  const fsmfolderPath = "apps/fsm-core-example/fsm";

  const deps = {
    db: pool,
  };

  // vitalsWorkflow is a reusable sub-workflow invoked by carVitals
  // (asyncOperationType "fsm"). load_fsm_from_json_v2 requires a referenced
  // child FSM to already
  // exist in fsm_core.fsm_states, so it must be loaded first, in its own
  // pass, before the rest of the folders (which include its invoker).
  await loadFsmJSONFromFolders(
    fsmfolderPath,
    ["carVitals", "creditCheck", "taskMachineConfig"],
    deps,
  );
  await loadFsmJSONFromFolders(
    fsmfolderPath,
    ["vitalsWorkflow"],
    deps,
  );
  logger.info("All workflows inserted successfully");
})();
