import { v4 as uuidv4 } from "uuid";
import { writeFileSync } from "node:fs";
import { isVersionFolderName, type WorkflowType } from "./util.ts";
import { loadFsmFromJsonV2 } from "../../../apps/fsm-core-db-ts/src/fsm-helper.ts";


async function loadFsmJSONFromFolder(
  dirEntryName: string,
  dirEntryNameVersion: string,
  folderPath: string,
  absFolderPath: string,
  parentSource: string,
  workflow_type: WorkflowType,
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
    const fsmResult = await loadFsmFromJsonV2(deps, fsmData, rootNodeText, fsmName, fsmVersion);
    console.log(`Successfully loaded FSM from ${fsmJson}:`, fsmResult);
    return fsmResult;
    
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
 */
export async function loadFsmJSONFromFolders(
  folderPath: string,
  workflow_type: WorkflowType,
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
      const folderResults = [];
      for await (const subEntry of Deno.readDir(fsmDirPath)) {
          if (subEntry.isDirectory) {
            if (isVersionFolderName(subEntry.name)) {
             
              const folderResult = await loadFsmJSONFromFolder(dirEntry.name, subEntry.name, folderPath, `${fsmDirPath}/${subEntry.name}`, dirEntry.name, workflow_type, deps);
              folderResults.push(folderResult);
              console.log(`Successfully loaded FSM from ${fsmDirPath}/${subEntry.name}`);
            }else {
              console.log(`Skipping non-versioned folder: ${subEntry.name} in ${fsmDirPath}`);
            }
          }
      }
      

    }
  }
}