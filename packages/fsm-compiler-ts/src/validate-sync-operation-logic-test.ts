import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureCompilerLogger } from "./logger.ts";
import { validateSyncOperationFromFolders } from "./validate-sync-operation-logic.ts";

dotenv.config({ path: "./../../.env" });
const logger = getLogger(["@pgfsm/compiler", "test"]);
await configureCompilerLogger();

(async () => {
  const sharedFSMfolderPath = "apps/fsm-core-example/sharedFSM";
  const fsmfolderPath = "apps/fsm-core-example/fsm";

  const skipSharedFSMDirs = [""];
  const skipFSMDirs = ["", ""];

  const outputSharedFSM = await validateSyncOperationFromFolders(
    sharedFSMfolderPath,
    "sharedFsm",
    skipSharedFSMDirs,
    [],
  );
  const outputFSM = await validateSyncOperationFromFolders(
    fsmfolderPath,
    "fsm",
    skipFSMDirs,
    outputSharedFSM,
  );
  logger.info("final output: {output}", { output: outputFSM });
})();
