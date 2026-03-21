import { v4 as uuidv4 } from "uuid";
import { writeFileSync } from "node:fs";
import { isVersionFolderName, type WorkflowType } from "./util.ts";


async function deleteFsmJSONFromFolder(
  dirEntryName: string,
  dirEntryNameVersion: string,
  folderPath: string,
  absFolderPath: string,
  parentSource: string,
  workflow_type: WorkflowType
) {
  try {
    await Deno.remove(`${absFolderPath}/xstate-fsm.json`);
    await Deno.remove(`${absFolderPath}/fsm.json`);
    // remove folder typescript if it exists
    await Deno.remove(`${absFolderPath}/typescript`, { recursive: true });
    // remove folder python if it exists
    await Deno.remove(`${absFolderPath}/python`, { recursive: true });
    console.log(`Deleted xstate-fsm.json and fsm.json from ${absFolderPath}`);
    
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log(`fsm.json or xstate-fsm.json is missing in ${absFolderPath}/${dirEntryName}, nothing to delete`);
    } else {
      console.error(`Failed to delete ${absFolderPath}/fsm.json:`, err);
    }
    
  }
}

export async function deleteFsmJSONFromFolders(
  folderPath: string,
  workflow_type: WorkflowType,
  skipDirs: string[] = []
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
             
              await deleteFsmJSONFromFolder(dirEntry.name, subEntry.name, folderPath, `${fsmDirPath}/${subEntry.name}`, dirEntry.name, workflow_type);
            }else {
              console.log(`Skipping non-timestamped folder: ${subEntry.name} in ${fsmDirPath}`);
            }
          }
        }

    }

  }
}

