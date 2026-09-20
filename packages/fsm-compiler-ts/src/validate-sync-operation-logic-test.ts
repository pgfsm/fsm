import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureCompilerLogger } from "./logger.ts";
import { validateSyncOperationFromFolders } from "./validate-sync-operation-logic.ts";

dotenv.config({ path: "./../../.env" });
const logger = getLogger(["@pgfsm/compiler", "test"]);
await configureCompilerLogger();

(async () => {
  const fsmfolderPath = "apps/fsm-core-example/fsm";

  const outputFSM = await validateSyncOperationFromFolders(
    fsmfolderPath,
    [],
  );
  logger.info("final output: {output}", { output: outputFSM });
})();
