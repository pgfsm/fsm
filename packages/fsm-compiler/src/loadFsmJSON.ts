import { v4 as uuidv4 } from "uuid";
import { writeFileSync } from "node:fs";
import { isVersionFolderName } from "./util.ts";
import { loadFsmStateFromJsonV2, loadFsmTransitionFromJsonV2 } from "../../../apps/fsm-core-db/src/fsm-helper.ts";


async function loadFsmJSONFromFolder(
  dirEntryName: string,
  dirEntryNameVersion: string,
  folderPath: string,
  absFolderPath: string,
  parentSource: string,
  workflow_type: "fsm" | "childfsm" | "sharedfsm" | "promise",
  deps: any
) {
  const fsmJson = `${absFolderPath}/fsm.json`;
  try {
    await Deno.stat(fsmJson);
    // 1. Load fsm.json file
    const fsmData = JSON.parse(await Deno.readTextFile(fsmJson));

    // 2. Process fsmData and insert into database using helper functions
    // Call loadFsmStateFromJsonV2 and loadFsmTransitionFromJsonV2 with fsmData
    const fsmName = dirEntryName;
    const fsmVersion = dirEntryNameVersion;
    const rootNodeText = null;
    const fsmStateResult = await loadFsmStateFromJsonV2(deps, fsmData, rootNodeText, fsmName, fsmVersion);
    const fsmTransitionResult = await loadFsmTransitionFromJsonV2(deps, fsmData, rootNodeText, fsmName, fsmVersion);
    
    
    
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log(`fsm.json is missing in ${absFolderPath}/${dirEntryName}`);
    } else {
      console.error(`Failed to import or process ${fsmJson}:`, err);
    }
  }

    

}

/**
 * Loads all FSM JSON files in a folder and processes them.
 * @param folderPath Absolute or relative path to the folder containing FSM JSON files
 * @param supabaseClient The Supabase client instance to use for database operations
 */
export async function loadFsmJSONFromFolders(
  folderPath: string,
  workflow_type: "fsm" | "childfsm" | "sharedfsm" | "promise",
  skipDirs: string[] = [],
  deps: any
) {
  if (folderPath.startsWith(".")) {
    throw new Error(`Invalid folder path: ${folderPath}. Folder paths cannot start with '.'`);
  }
  if (folderPath.endsWith("/")) {
    throw new Error(`Invalid folder path: ${folderPath}. Folder paths cannot end with '/'`);
  }
  if (folderPath.startsWith("/")) {
    console.log(`Importing workflows from absolute path: ${folderPath}`);
  } else {
    console.log(`Importing workflows from relative path: ${folderPath} to ${Deno.cwd()}`);
  }
  const absFolderPath = folderPath.startsWith("/") ? folderPath : `${Deno.cwd()}/${folderPath}`;
  for await (const dirEntry of Deno.readDir(absFolderPath)) {
    if (dirEntry.isDirectory) {
      if (skipDirs.includes(dirEntry.name)) {
        continue;
      }
  

      const fsmDirPath = `${absFolderPath}/${dirEntry.name}`;

      for await (const subEntry of Deno.readDir(fsmDirPath)) {
          if (subEntry.isDirectory) {
            if (isVersionFolderName(subEntry.name)) {
             
              await loadFsmJSONFromFolder(dirEntry.name, subEntry.name, folderPath, `${fsmDirPath}/${subEntry.name}`, dirEntry.name, workflow_type, deps);
            }else {
              console.log(`Skipping non-versioned folder: ${subEntry.name} in ${fsmDirPath}`);
            }
          }
        }

    }
  }
}