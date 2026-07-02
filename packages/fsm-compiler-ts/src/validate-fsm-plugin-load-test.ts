import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureCompilerLogger } from "./logger.ts";
import {
  validateFsmPluginLoadFromFolders,
  validatePromisePluginLoadFromFolders,
} from "./validate-fsm-plugin-load.ts";

dotenv.config({ path: "./../../.env" });
const logger = getLogger(["@pgfsm/compiler", "test"]);
await configureCompilerLogger();

(async () => {
  const sharedPromisefolderPath = "apps/fsm-core-example/sharedPromise";
  const sharedFSMfolderPath = "apps/fsm-core-example/sharedFSM";
  const fsmfolderPath = "apps/fsm-core-example/fsm";

  const skipSharedPromiseDirs = [""];
  const skipSharedFSMDirs = [""];
  const skipFSMDirs = ["", ""];
  const outputSharedPromise = await validatePromisePluginLoadFromFolders(
    sharedPromisefolderPath,
    "sharedPromise",
    skipSharedPromiseDirs,
    [],
  );
  const outputSharedFSM = await validateFsmPluginLoadFromFolders(
    sharedFSMfolderPath,
    "sharedFsm",
    skipSharedFSMDirs,
    outputSharedPromise,
  );
  const outputFSM = await validateFsmPluginLoadFromFolders(
    fsmfolderPath,
    "fsm",
    skipFSMDirs,
    [...outputSharedPromise, ...outputSharedFSM],
  );
  logger.info("final output: {output}", { output: outputFSM });
})();
