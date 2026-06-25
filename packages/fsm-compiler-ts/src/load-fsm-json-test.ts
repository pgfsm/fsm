import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureCompilerLogger } from "./logger.ts";
import { loadFsmJSONFromFolders } from './load-fsm-json.ts';
import { Pool } from "pg";

dotenv.config({ path: "./../../.env" });
const logger = getLogger(["@pgfsm/compiler", "test"]);
await configureCompilerLogger();

const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });

(async () => {
  const sharedFSMfolderPath = 'apps/fsm-core-example/sharedFSM';
  const fsmfolderPath = 'apps/fsm-core-example/fsm';

  const deps = {
    db: pool,
  };

  const skipSharedFSMDirs = [""];
  const skipFSMDirs = ["",""];

  await loadFsmJSONFromFolders(sharedFSMfolderPath, "sharedFsm", skipSharedFSMDirs, deps);
  await loadFsmJSONFromFolders(fsmfolderPath, "fsm", skipFSMDirs, deps);
  logger.info("All workflows inserted successfully");
})();
