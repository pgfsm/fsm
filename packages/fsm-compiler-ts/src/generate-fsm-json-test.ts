import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureCompilerLogger } from "./logger.ts";
import { generateFsmJSONFromFolders } from './generate-fsm-json.ts';

dotenv.config({ path: "./../../.env" });
const logger = getLogger(["@pgfsm/compiler", "test"]);
await configureCompilerLogger();

const sharedFSMfolderPath = 'apps/fsm-core-example/sharedFSM';
const fsmfolderPath = 'apps/fsm-core-example/fsm';

(async () => {
  logger.info("=== generateFsmJSON tests ===");

  const skipSharedFSMDirs = ["vitalsWorkflow"];
  const skipFSMDirs = ["carVitals","taskMachineConfig"];
  logger.info("--- generate sharedFSM (showRecommendation = true) ---");
  await generateFsmJSONFromFolders(sharedFSMfolderPath, "sharedFsm", skipSharedFSMDirs, true);
  logger.info("sharedFSM generated with recommendation");

  logger.info("--- generate fsm (showRecommendation = true) ---");
  await generateFsmJSONFromFolders(fsmfolderPath, "fsm", skipFSMDirs, true);
  logger.info("fsm generated with recommendation");

  logger.info("=== generateFsmJSON tests complete ===");
})();
