import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureCompilerLogger } from "./logger.ts";
import { loadFsmJSONFromFolders } from "./load-fsm-json.ts";
// @ts-types="@types/pg"
import { Pool } from "pg";

dotenv.config({ path: "./../../.env" });
const logger = getLogger(["@pgfsm/compiler", "test"]);
await configureCompilerLogger();

const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });

(async () => {
  const fsmfolderPath = "apps/fsm-core-example/fsm";

  const deps = {
    db: pool,
    useSupabase: false,
  };

  // One pass: the loader orders vitalsWorkflow (a child FSM that carVitals
  // invokes) before carVitals itself.
  await loadFsmJSONFromFolders(fsmfolderPath, [], deps);
  logger.info("All workflows inserted successfully");
})();
