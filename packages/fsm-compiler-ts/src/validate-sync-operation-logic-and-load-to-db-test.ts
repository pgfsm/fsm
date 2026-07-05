import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureCompilerLogger } from "./logger.ts";
import { validateSyncOperationAndLoadToDb } from "./validate-sync-operation-logic-and-load-to-db.ts";
import { Pool } from "pg";

dotenv.config({ path: "./../../.env" });
const logger = getLogger(["@pgfsm/compiler", "test"]);
await configureCompilerLogger();

const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });

(async () => {
  const sharedFSMfolderPath = "apps/fsm-core-example/sharedFSM";
  const fsmfolderPath = "apps/fsm-core-example/fsm";

  const deps = { db: pool, useSupabase: false };

  const skipSharedFSMDirs = [""];
  const skipFSMDirs = ["", ""];

  const outputSharedFSM = await validateSyncOperationAndLoadToDb(
    deps,
    sharedFSMfolderPath,
    "sharedFsm",
    skipSharedFSMDirs,
    [],
  );
  const outputFSM = await validateSyncOperationAndLoadToDb(
    deps,
    fsmfolderPath,
    "fsm",
    skipFSMDirs,
    outputSharedFSM,
  );
  logger.info("final output: {output}", { output: outputFSM });

  await pool.end();
})();
