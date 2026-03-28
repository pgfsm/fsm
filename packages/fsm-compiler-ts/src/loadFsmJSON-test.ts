import dotenv from "dotenv";
import { loadFsmJSONFromFolders } from './loadFsmJSON.ts';

import { pool } from "@fsm/db";

dotenv.config({ path: "./../../.env" });



(async () => {

  // const folderPath = Deno.args[0] || Deno.cwd()+ "/packages/fsm-compiler-ts/src/sampleFSMfromFolder";
  const sharedFSMfolderPath = 'packages/fsm-compiler-ts/src/example/sharedFSM';
  const fsmfolderPath = 'packages/fsm-compiler-ts/src/example/fsm';

  const deps = {
    db: pool,
  };

  // const skipSharedFSMDirs = ["vitalsWorkflow"];
  // const skipFSMDirs = ["carVitals","taskMachineConfig"];
  const skipSharedFSMDirs = [""];
  const skipFSMDirs = ["",""];

  const outputSharedFSM = await loadFsmJSONFromFolders(sharedFSMfolderPath, "sharedFsm", skipSharedFSMDirs, deps);
  const outputFSM = await loadFsmJSONFromFolders(fsmfolderPath, "fsm", skipFSMDirs, deps);
  console.log("✅ All workflows inserted successfully");
})();

