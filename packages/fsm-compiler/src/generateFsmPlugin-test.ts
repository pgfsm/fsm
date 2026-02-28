import dotenv from "dotenv";
import { generateFsmPluginFromFolders } from './generateFsmPlugin.ts';
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: "./../../.env" });



(async () => {
  
  // const folderPath = Deno.args[0] || Deno.cwd()+ "/packages/fsm-compiler/src/sampleFSMfromFolder";
  const sharedFSMfolderPath = 'packages/fsm-compiler/src/example/sharedFSM';
  const fsmfolderPath = 'packages/fsm-compiler/src/example/fsm';
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

  const outputSharedFSM = await generateFsmPluginFromFolders(sharedFSMfolderPath, "sharedFSM");
  const outputFSM = await generateFsmPluginFromFolders(fsmfolderPath, "fsm");
  // console.log("✅ All workflows inserted successfully");
})();

