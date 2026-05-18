import dotenv from "dotenv";
import { deleteFsmJSONFromFolders } from './deleteFsmJSON.ts';

dotenv.config({ path: "./../../.env" });



(async () => {
  
  // const folderPath = Deno.args[0] || Deno.cwd()+ "/packages/fsm-compiler-ts/src/sampleFSMfromFolder";
  // const sharedFSMfolderPath = 'packages/fsm-compiler-ts/src/example/sharedFSM';
  // const fsmfolderPath = 'packages/fsm-compiler-ts/src/example/fsm';
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
 

  const skipSharedFSMDirs = ["vitalsWorkflow"];
  const skipFSMDirs = ["carVitals","taskMachineConfig"];
  // const skipSharedFSMDirs = [];
  // const skipFSMDirs = [];
  const outputSharedFSM = await deleteFsmJSONFromFolders(sharedFSMfolderPath, "sharedFsm", skipSharedFSMDirs);
  const outputFSM = await deleteFsmJSONFromFolders(fsmfolderPath, "fsm", skipFSMDirs);


  // console.log("✅ All workflows inserted successfully");
})();

