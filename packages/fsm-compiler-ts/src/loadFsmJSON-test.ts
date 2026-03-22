import dotenv from "dotenv";
import { loadFsmJSONFromFolders } from './loadFsmJSON.ts';
import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import {
  pool as db,
} from "../../../apps/fsm-core-db-ts/src/pg-client.ts";

dotenv.config({ path: "./../../.env" });



(async () => {
  
  // const folderPath = Deno.args[0] || Deno.cwd()+ "/packages/fsm-compiler-ts/src/sampleFSMfromFolder";
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
 

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Missing SUPABASE_URL, SUPABASE_ANON_KEY env variable"
    );
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const pool = new Pool({
    connectionString: Deno.env.get("DATABASE_URL"),
  });

  const deps = {
    db: pool, // Use the pg Pool for database operations
    useSupabase: false,
    supabase: supabase,
  };

  // const skipSharedFSMDirs = ["vitalsWorkflow"];
  // const skipFSMDirs = ["carVitals","taskMachineConfig"];
  const skipSharedFSMDirs = [""];
  const skipFSMDirs = ["",""];

  const outputSharedFSM = await loadFsmJSONFromFolders(sharedFSMfolderPath, "sharedFsm", skipSharedFSMDirs, deps);
  const outputFSM = await loadFsmJSONFromFolders(fsmfolderPath, "fsm", skipFSMDirs, deps);
  console.log("✅ All workflows inserted successfully");
})();

