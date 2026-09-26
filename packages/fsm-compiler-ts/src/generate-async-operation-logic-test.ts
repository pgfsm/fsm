import dotenv from "dotenv";
import { generateAsyncOperationLogicFromFolders } from "./generate-async-operation-logic.ts";

dotenv.config({ path: "./../../.env" });

(async () => {
  const fsmfolderPath = "apps/fsm-core-example/fsm";

  const skipFSMDirs = ["carVitals", "taskMachineConfig", "vitalsWorkflow"];

  // Async operation logic (actors) — routed by each invoke's asyncOperationLanguage.
  await generateAsyncOperationLogicFromFolders(
    fsmfolderPath,
    skipFSMDirs,
    fsmfolderPath,
  );
})();
