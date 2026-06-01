import dotenv from "dotenv";
import { validateAndLoadFsmFromFolders, validateAndLoadPromiseFromFolders } from './load-and-validate-fsm.ts';
import { Pool } from "pg";

dotenv.config({ path: "./../../.env" });


const pool = new Pool({ connectionString: Deno.env.get("DATABASE_URL") });

(async () => {
  
  // const folderPath = Deno.args[0] || Deno.cwd()+ "/packages/fsm-compiler-ts/src/sampleFSMfromFolder";
  // const sharedPromisefolderPath = 'packages/fsm-compiler-ts/src/example/sharedPromise';
  // const sharedFSMfolderPath = 'packages/fsm-compiler-ts/src/example/sharedFSM';
  // const fsmfolderPath = 'packages/fsm-compiler-ts/src/example/fsm';
  
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

  const outputSharedPromise = await validateAndLoadPromiseFromFolders(deps, sharedPromisefolderPath, "sharedPromise", skipSharedPromiseDirs, []);
  const outputSharedFSM = await validateAndLoadFsmFromFolders(deps, sharedFSMfolderPath, "sharedFsm", skipSharedFSMDirs, outputSharedPromise);
  // pass pure array of outputSharedFSM and outputSharedPromise to validateFsmPluginLoadFromFolders to resolve dependencies for FSM plugins.
  const outputFSM = await validateAndLoadFsmFromFolders(deps, fsmfolderPath, "fsm", skipFSMDirs, [...outputSharedPromise, ...outputSharedFSM]);
  console.log("final output:", outputFSM);
})();

