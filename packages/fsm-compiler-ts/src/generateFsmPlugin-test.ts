import dotenv from "dotenv";
import { generateFsmPluginFromFolders } from './generateFsmPlugin.ts';

dotenv.config({ path: "./../../.env" });



(async () => {
  
  // const folderPath = Deno.args[0] || Deno.cwd()+ "/packages/fsm-compiler-ts/src/sampleFSMfromFolder";
  // const sharedFSMfolderPath = 'packages/fsm-compiler-ts/src/example/sharedFSM';
  // const fsmfolderPath = 'packages/fsm-compiler-ts/src/example/fsm';
  const sharedFSMfolderPath = 'apps/fsm-core-example/sharedFSM';
  const fsmfolderPath = 'apps/fsm-core-example/fsm';
 
 

  const skipSharedFSMDirs = ["vitalsWorkflow"];
  const skipFSMDirs = ["carVitals","taskMachineConfig"];
  // const skipSharedFSMDirs = [];
  // const skipFSMDirs = [];
  const outputSharedFSM = await generateFsmPluginFromFolders(sharedFSMfolderPath, "sharedFsm", skipSharedFSMDirs);
  const outputFSM = await generateFsmPluginFromFolders(fsmfolderPath, "fsm", skipFSMDirs);
  // console.log("✅ All workflows inserted successfully");
})();

