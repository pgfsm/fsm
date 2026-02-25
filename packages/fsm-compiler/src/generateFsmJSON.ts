import { v4 as uuidv4 } from "uuid";
import { writeFileSync } from "node:fs";

async function deleteFsmJSONFromFolder(
  dirEntryName: string,
  dirEntryNameVersion: string,
  folderPath: string,
  absFolderPath: string,
  parentSource: string,
  workflow_type: "fsm" | "childfsm" | "sharedfsm" | "promise"
) {
  try {
    await Deno.remove(`${absFolderPath}/fsm.json`);
    console.log(`Deleted fsm.json from ${absFolderPath}/fsm.json`);
    
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log(`fsm.json is missing in ${absFolderPath}/${dirEntryName}, nothing to delete`);
    } else {
      console.error(`Failed to delete ${absFolderPath}/fsm.json:`, err);
    }
    
  }
}

export async function deleteFsmJSONFromFolders(
  folderPath: string,
  workflow_type: "fsm" | "childfsm" | "sharedfsm" | "promise"
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
      if (dirEntry.name === "promise" || dirEntry.name === "sharedFSM") {
        continue;
      }
  

      const fsmDirPath = `${absFolderPath}/${dirEntry.name}`;

      for await (const subEntry of Deno.readDir(fsmDirPath)) {
          if (subEntry.isDirectory) {
            // check if subEntry name matches timestamp pattern YYYYMMDDHHMMSS
            const timestampPattern = /^\d{14}$/;
            if (timestampPattern.test(subEntry.name)) {
             
              await deleteFsmJSONFromFolder(dirEntry.name, subEntry.name, folderPath, `${fsmDirPath}/${subEntry.name}`, dirEntry.name, workflow_type);
            }else {
              console.log(`Skipping non-timestamped folder: ${subEntry.name} in ${fsmDirPath}`);
            }
          }
        }

    }

  }
}


async function generateFsmJSONFromFolder(
  dirEntryName: string,
  dirEntryNameVersion: string,
  folderPath: string,
  absFolderPath: string,
  parentSource: string,
  workflow_type: "fsm" | "childfsm" | "sharedfsm" | "promise"
) {
  
  const createMachinePath = `${absFolderPath}/machine.ts`;
  try {
    await Deno.stat(createMachinePath);
    const module = await import(`file://${createMachinePath}`);
    const machineConfig = module.default;
    if (!machineConfig) {
      console.error(`No valid export found in ${createMachinePath}`);
      return;
    }
    if (
      typeof machineConfig.id === "string" &&
      typeof machineConfig.config === "object" &&
      typeof machineConfig.toJSON === "function"
    ) {
      const jsonOutput = JSON.stringify(machineConfig.toJSON(), null, 2);
      writeFileSync(`${absFolderPath}/fsm.json`, jsonOutput);
      console.log(`Wrote new fsm.json to ${absFolderPath}/fsm.json`);
      
    } else {
      console.error(`Export in ${createMachinePath} is not a valid xstate machine config`);
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log(`machine.ts is missing in ${absFolderPath}/${dirEntryName}`);
    } else {
      console.error(`Failed to import or process ${createMachinePath}:`, err);
    }
  }

}


export async function generateFsmJSONFromFolders(
  folderPath: string,
  workflow_type: "fsm" | "childfsm" | "sharedfsm" | "promise",
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
          // check if subEntry name matches timestamp pattern YYYYMMDDHHMMSS
          const timestampPattern = /^\d{14}$/;
          if (timestampPattern.test(subEntry.name)) {
            await generateFsmJSONFromFolder(dirEntry.name, subEntry.name, folderPath, `${fsmDirPath}/${subEntry.name}`, dirEntry.name, workflow_type);
          } else {
            console.log(`Skipping non-timestamped folder: ${subEntry.name} in ${fsmDirPath}`);
          }
        }
      }
    }
  }
}