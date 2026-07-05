import dotenv from "dotenv";
import { generateAsyncOperationLogicFromFolders } from "./generate-async-operation-logic.ts";

dotenv.config({ path: "./../../.env" });

(async () => {
  const sharedFSMfolderPath = "apps/fsm-core-example/sharedFSM";
  const fsmfolderPath = "apps/fsm-core-example/fsm";

  const skipSharedFSMDirs = ["vitalsWorkflow"];
  const skipFSMDirs = ["carVitals", "taskMachineConfig"];

  // Async operation logic (actors) — routed by each invoke's fsmLanguage.
  await generateAsyncOperationLogicFromFolders(
    sharedFSMfolderPath,
    "sharedFsm",
    skipSharedFSMDirs,
  );
  await generateAsyncOperationLogicFromFolders(
    fsmfolderPath,
    "fsm",
    skipFSMDirs,
  );
})();
