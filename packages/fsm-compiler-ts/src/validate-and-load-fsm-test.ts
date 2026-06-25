import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureCompilerLogger } from "./logger.ts";
import { validateAndLoadFsmFromFolders, validateAndLoadPromiseFromFolders } from './validate-and-load-fsm.ts';
import { Pool } from "pg";

dotenv.config({ path: "./../../.env" });
const logger = getLogger(["@pgfsm/compiler", "test"]);
await configureCompilerLogger();

const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });

(async () => {
  const sharedPromisefolderPath = 'apps/fsm-core-example/sharedPromise';
  const sharedFSMfolderPath = 'apps/fsm-core-example/sharedFSM';
  const fsmfolderPath = 'apps/fsm-core-example/fsm';

  const deps = {
    db: pool,
  };

  const skipSharedPromiseDirs = [""];
  const skipSharedFSMDirs = [""];
  const skipFSMDirs = ["",""];

  const outputSharedPromise = await validateAndLoadPromiseFromFolders(deps, sharedPromisefolderPath, "sharedPromise", skipSharedPromiseDirs, []);
  const outputSharedFSM = await validateAndLoadFsmFromFolders(deps, sharedFSMfolderPath, "sharedFsm", skipSharedFSMDirs, outputSharedPromise);
  const outputFSM = await validateAndLoadFsmFromFolders(deps, fsmfolderPath, "fsm", skipFSMDirs, [...outputSharedPromise, ...outputSharedFSM]);
  logger.info("final output: {output}", { output: outputFSM });
})();
