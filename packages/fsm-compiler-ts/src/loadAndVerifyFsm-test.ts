import dotenv from "dotenv";
import { loadAndVerifyFsmFromFolders, loadAndVerifyPromiseFromFolders } from './loadAndVerifyFsm.ts';
import { pool } from "@fsm/db";

dotenv.config({ path: "./../../.env" });



(async () => {
  
  // const folderPath = Deno.args[0] || Deno.cwd()+ "/packages/fsm-compiler-ts/src/sampleFSMfromFolder";
  const sharedPromisefolderPath = 'packages/fsm-compiler-ts/src/example/sharedPromise';
  const sharedFSMfolderPath = 'packages/fsm-compiler-ts/src/example/sharedFSM';
  const fsmfolderPath = 'packages/fsm-compiler-ts/src/example/fsm';
 
  

  const deps = {
    db: pool,
  };

  // const skipSharedFSMDirs = ["vitalsWorkflow"];
  // const skipFSMDirs = ["carVitals","taskMachineConfig"];
  const skipSharedPromiseDirs = [""];
  const skipSharedFSMDirs = [""];
  const skipFSMDirs = ["",""];

  const outputSharedPromise = await loadAndVerifyPromiseFromFolders(deps, sharedPromisefolderPath, "sharedPromise", skipSharedPromiseDirs, []);
  const outputSharedFSM = await loadAndVerifyFsmFromFolders(deps, sharedFSMfolderPath, "sharedFsm", skipSharedFSMDirs, outputSharedPromise);
  // pass pure array of outputSharedFSM and outputSharedPromise to validateFsmPluginLoadFromFolders to resolve dependencies for FSM plugins. 
  const outputFSM = await loadAndVerifyFsmFromFolders(deps, fsmfolderPath, "fsm", skipFSMDirs, [...outputSharedPromise, ...outputSharedFSM]);
  console.log("final output:", outputFSM);
})();

