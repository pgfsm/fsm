import { getLogger } from "@logtape/logtape";
import { v4 as uuidv4 } from "uuid";
import { writeFileSync } from "node:fs";

const logger = getLogger(["@pgfsm/compiler", "load"]);
import { isVersionFolderName, type WorkflowType } from "./util.ts";
import { loadFsmFromJson, type DBDeps } from "@pgfsm/db";


async function loadFsmJSONFromFolder(
  dirEntryName: string,
  dirEntryNameVersion: string,
  folderPath: string,
  absFolderPath: string,
  parentSource: string,
  workflowType: WorkflowType,
  deps: DBDeps
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
    const fsmResult = await loadFsmFromJson(deps, fsmData, null, workflowType, fsmName, fsmVersion);
    logger.info("Successfully loaded FSM from {path}: {result}", { path: fsmJson, result: fsmResult });
    return fsmResult;
    
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      logger.info("fsm.json is missing in {path}", { path: `${absFolderPath}/${dirEntryName}` });
    } else {
      logger.error("Failed to import or process {path}: {error}", { path: fsmJson, error: err });
    }
  }

    

}

/**
 * Loads all FSM JSON files in a folder and processes them.
 * @param folderPath Absolute or relative path to the folder containing FSM JSON files
 */
export async function loadFsmJSONFromFolders(
  folderPath: string,
  workflowType: WorkflowType,
  skipDirs: string[] = [],
  deps: DBDeps
): Promise<any[]> {
  if (folderPath.startsWith(".")) {
    throw new Error(`Invalid folder path: ${folderPath}. Folder paths cannot start with '.'`);
  }
  if (folderPath.endsWith("/")) {
    throw new Error(`Invalid folder path: ${folderPath}. Folder paths cannot end with '/'`);
  }
  if (folderPath.startsWith("/")) {
    logger.info("Importing workflows from absolute path: {path}", { path: folderPath });
  } else {
    logger.info("Importing workflows from relative path: {path} to {cwd}", { path: folderPath, cwd: Deno.cwd() });
  }
  const absFolderPath = folderPath.startsWith("/") ? folderPath : `${Deno.cwd()}/${folderPath}`;
  const folderResults: any[] = [];
  for await (const dirEntry of Deno.readDir(absFolderPath)) {
    if (dirEntry.isDirectory) {
      if (skipDirs.includes(dirEntry.name)) {
        continue;
      }
      const fsmDirPath = `${absFolderPath}/${dirEntry.name}`;
      for await (const subEntry of Deno.readDir(fsmDirPath)) {
        if (subEntry.isDirectory) {
          if (isVersionFolderName(subEntry.name)) {
            const folderResult = await loadFsmJSONFromFolder(dirEntry.name, subEntry.name, folderPath, `${fsmDirPath}/${subEntry.name}`, dirEntry.name, workflowType, deps);
            folderResults.push(folderResult);
            logger.info("Successfully loaded FSM from {path}", { path: `${fsmDirPath}/${subEntry.name}` });
          } else {
            logger.info("Skipping non-versioned folder: {name} in {dir}", { name: subEntry.name, dir: fsmDirPath });
          }
        }
      }
    }
  }
  return folderResults;
}