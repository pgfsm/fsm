import dotenv from "dotenv";
import { validateFsmPluginLoadFromFolders, validatePromisePluginLoadFromFolders } from './validateFsmPluginLoad.ts';
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: "./../../.env" });



(async () => {
  
  // const folderPath = Deno.args[0] || Deno.cwd()+ "/packages/fsm-compiler-ts/src/sampleFSMfromFolder";
  const sharedPromisefolderPath = 'packages/fsm-compiler-ts/src/example/sharedPromise';
  const sharedFSMfolderPath = 'packages/fsm-compiler-ts/src/example/sharedFSM';
  const fsmfolderPath = 'packages/fsm-compiler-ts/src/example/fsm';
  // try {
  //   const stat = await Deno.stat(folderPath);
  //   if (!stat.isDirectory) {
  //     throw new Error(`Provided path '${folderPath}' is not a directory.`);
  //   }
  // } catch (err) {
  //   throw new Error(`Directory '${folderPath}' does not exist.`);
  // }
 

  // const supabaseUrl = process.env.SUPABASE_URL;
  // const supabaseKey = process.env.SUPABASE_ANON_KEY;
  // const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // if (!supabaseUrl || !supabaseKey) {
  //   throw new Error(
  //     "Missing SUPABASE_URL, SUPABASE_ANON_KEY env variable"
  //   );
  // }
  // const supabase = createClient(supabaseUrl, supabaseKey);
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

