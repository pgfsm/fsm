import { getLogger } from "@logtape/logtape";
import { v4 as uuidv4 } from "uuid";
import { writeFileSync } from "node:fs";

const logger = getLogger(["@pgfsm/compiler", "delete"]);
import { isVersionFolderName, type WorkflowType } from "./util.ts";


async function deleteFsmJSONFromFolder(
  dirEntryName: string,
  dirEntryNameVersion: string,
  folderPath: string,
  absFolderPath: string,
  parentSource: string,
  workflowType: WorkflowType
) {
  try {
    await Deno.remove(`${absFolderPath}/xstate-fsm.json`);
    await Deno.remove(`${absFolderPath}/fsm.json`);
    // remove folder typescript if it exists
    await Deno.remove(`${absFolderPath}/typescript`, { recursive: true });
    // remove folder python if it exists
    await Deno.remove(`${absFolderPath}/python`, { recursive: true });
    logger.info("Deleted xstate-fsm.json and fsm.json from {path}", { path: absFolderPath });
    
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      logger.info("fsm.json or xstate-fsm.json is missing in {path}, nothing to delete", { path: `${absFolderPath}/${dirEntryName}` });
    } else {
      logger.error("Failed to delete {path}/fsm.json: {error}", { path: absFolderPath, error: err });
    }
    
  }
}

export async function deleteFsmJSONFromFolders(
  folderPath: string,
  workflowType: WorkflowType,
  skipDirs: string[] = []
) {
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
  for await (const dirEntry of Deno.readDir(absFolderPath)) {
    
    if (dirEntry.isDirectory) {
      if (skipDirs.includes(dirEntry.name)) {
        continue;
      }
  

      const fsmDirPath = `${absFolderPath}/${dirEntry.name}`;

      for await (const subEntry of Deno.readDir(fsmDirPath)) {
          if (subEntry.isDirectory) {
            if (isVersionFolderName(subEntry.name)) {
             
              await deleteFsmJSONFromFolder(dirEntry.name, subEntry.name, folderPath, `${fsmDirPath}/${subEntry.name}`, dirEntry.name, workflowType);
            }else {
              logger.info("Skipping non-timestamped folder: {name} in {dir}", { name: subEntry.name, dir: fsmDirPath });
            }
          }
        }

    }

  }
}

