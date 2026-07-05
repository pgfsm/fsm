import dotenv from "dotenv";
import { getLogger } from "@logtape/logtape";
import { configureCompilerLogger } from "./logger.ts";
import { validateAsyncOperationFromFolders } from "./validate-async-operation-logic.ts";

dotenv.config({ path: "./../../.env" });
const logger = getLogger(["@pgfsm/compiler", "test"]);
await configureCompilerLogger();

(async () => {
  const sharedPromisefolderPath = "apps/fsm-core-example/sharedPromise";

  const skipSharedPromiseDirs = [""];

  const outputSharedPromise = await validateAsyncOperationFromFolders(
    sharedPromisefolderPath,
    "sharedPromise",
    skipSharedPromiseDirs,
    [],
  );
  logger.info("final output: {output}", { output: outputSharedPromise });
})();
