import dotenv from "dotenv";
import { generateSyncOperationLogicFromFolders } from "./generate-sync-operation-logic.ts";

dotenv.config({ path: "./../../.env" });

(async () => {
  const fsmfolderPath = "apps/fsm-core-example/fsm";
  const skipFSMDirs = ["carVitals", "taskMachineConfig"];

  // Sync operation logic (actions/guards/delays) — generated in TypeScript.
  await generateSyncOperationLogicFromFolders(
    fsmfolderPath,
    "fsm",
    ["typescript"],
    skipFSMDirs,
  );
})();
