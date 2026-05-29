import dotenv from "dotenv";
import { loadFsmJSONFromFolders } from './loadFsmJSON.ts';

import { Pool } from "pg";

dotenv.config({ path: "./../../.env" });


const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });


(async () => {

  // const folderPath = Deno.args[0] || Deno.cwd()+ "/packages/fsm-compiler-ts/src/sampleFSMfromFolder";
 

  const sharedPromisefolderPath = 'apps/fsm-core-example/sharedPromise';
  const sharedFSMfolderPath = 'apps/fsm-core-example/sharedFSM';
  const fsmfolderPath = 'apps/fsm-core-example/fsm';

  const deps = {
    db: pool,
  };

  // const skipSharedFSMDirs = ["vitalsWorkflow"];
  // const skipFSMDirs = ["carVitals","taskMachineConfig"];
  const skipSharedPromiseDirs = [""];
  const skipSharedFSMDirs = [""];
  const skipFSMDirs = ["",""];

  const outputSharedFSM = await loadFsmJSONFromFolders(sharedFSMfolderPath, "sharedFsm", skipSharedFSMDirs, deps);
  const outputFSM = await loadFsmJSONFromFolders(fsmfolderPath, "fsm", skipFSMDirs, deps);
  console.log("✅ All workflows inserted successfully");
})();

