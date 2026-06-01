import dotenv from "dotenv";
import { validateFsmPluginLoadFromFolders, validatePromisePluginLoadFromFolders } from './validate-fsm-plugin-load.ts';

dotenv.config({ path: "./../../.env" });



(async () => {
  
  // const folderPath = Deno.args[0] || Deno.cwd()+ "/packages/fsm-compiler-ts/src/sampleFSMfromFolder";
  // const sharedPromisefolderPath = 'packages/fsm-compiler-ts/src/example/sharedPromise';
  // const sharedFSMfolderPath = 'packages/fsm-compiler-ts/src/example/sharedFSM';
  // const fsmfolderPath = 'packages/fsm-compiler-ts/src/example/fsm';
  const sharedPromisefolderPath = 'apps/fsm-core-example/sharedPromise';
  const sharedFSMfolderPath = 'apps/fsm-core-example/sharedFSM';
  const fsmfolderPath = 'apps/fsm-core-example/fsm';
  // try {
  //   const stat = await Deno.stat(folderPath);
  //   if (!stat.isDirectory) {
  //     throw new Error(`Provided path '${folderPath}' is not a directory.`);
  //   }
  // } catch (err) {
  //   throw new Error(`Directory '${folderPath}' does not exist.`);
  // }
 

  // const skipSharedFSMDirs = ["vitalsWorkflow"];
  // const skipFSMDirs = ["carVitals","taskMachineConfig"];
  const skipSharedPromiseDirs = [""];
  const skipSharedFSMDirs = [""];
  const skipFSMDirs = ["",""];
  const outputSharedPromise = await validatePromisePluginLoadFromFolders(sharedPromisefolderPath, "sharedPromise", skipSharedPromiseDirs, []);
  const outputSharedFSM = await validateFsmPluginLoadFromFolders(sharedFSMfolderPath, "sharedFsm", skipSharedFSMDirs, outputSharedPromise);
  // pass pure array of outputSharedFSM and outputSharedPromise to validateFsmPluginLoadFromFolders to resolve dependencies for FSM plugins. 
  const outputFSM = await validateFsmPluginLoadFromFolders(fsmfolderPath, "fsm", skipFSMDirs, [...outputSharedPromise, ...outputSharedFSM]);
  console.log("final output:", outputFSM);
  
})();

