import { v4 as uuidv4 } from "uuid";
import { writeFileSync } from "node:fs";

// Import Ajv for JSON schema validation
import Ajv from "ajv";
import machineSchema from "../../database-src/fsm.machine.schema.v1.json" with { type: "json" };
import { isVersionFolderName, type WorkflowType } from "./util.ts";

import { validateFsmPluginLoadFromFolder } from "./validateFsmPluginLoad.ts";
import { validatePromisePluginLoadFromFolder } from "./validateFsmPluginLoad.ts";
import { loadFsmFromJsonV2 } from "../../../apps/fsm-core-db-ts/src/fsm-helper.ts";

export async function loadAndVerifyPromiseFromFolders(
  deps: any,
  folderPath: string,
  workflow_type: WorkflowType,
  skipDirs: string[] = [],
  availableActors: { src: string; fsmType?: string; fsmVersion?: string }[] = [],
) {
  if (folderPath.startsWith(".")) {
    throw new Error(
      `Invalid folder path: ${folderPath}. Folder paths cannot start with '.'`,
    );
  }
  if (folderPath.endsWith("/")) {
    throw new Error(
      `Invalid folder path: ${folderPath}. Folder paths cannot end with '/'`,
    );
  }
  if (folderPath.startsWith("/")) {
    console.log(`Importing workflows from absolute path: ${folderPath}`);
  } else {
    console.log(
      `Importing workflows from relative path: ${folderPath} to ${Deno.cwd()}`,
    );
  }
  const absFolderPath = folderPath.startsWith("/")
    ? folderPath
    : `${Deno.cwd()}/${folderPath}`;

  const allFolderResults = [];
  // check if absFolderPath exists and is a directory
  try {
    const stat = await Deno.stat(absFolderPath);
    if (!stat.isDirectory) {
      throw new Error(`Provided path '${absFolderPath}' is not a directory.`);
    }
    for await (const dirEntry of Deno.readDir(absFolderPath)) {
      if (dirEntry.isDirectory) {
        if (skipDirs.includes(dirEntry.name)) {
          continue;
        }

        const fsmDirPath = `${absFolderPath}/${dirEntry.name}`;

        for await (const subEntry of Deno.readDir(fsmDirPath)) {
          if (subEntry.isDirectory) {
            if (isVersionFolderName(subEntry.name)) {
              
              const folderResult = await validatePromisePluginLoadFromFolder(
                dirEntry.name,
                subEntry.name,
                `${fsmDirPath}/${subEntry.name}`,
                folderPath,
                dirEntry.name,
                fsmDirPath,
                workflow_type,
                availableActors,
              );
              console.log(
                `Validation result for ${dirEntry.name}/${subEntry.name}:`,
                folderResult,
              );
              
              allFolderResults.push(folderResult);
            } else {
              console.log(
                `Skipping non-versioned folder: ${subEntry.name} in ${fsmDirPath}`,
              );
            }
          }
        }
      }
    }
    console.log("All folder validation results:", allFolderResults);
    
  } catch (err) {
    // throw new Error(`Directory '${absFolderPath}' does not exist.`);
    console.error(`Error occurred while reading directory '${absFolderPath}':`, err);
  }  
  
  return allFolderResults;
}

export async function loadAndVerifyFsmFromFolders(
  deps: any,
  folderPath: string,
  workflow_type: WorkflowType,
  skipDirs: string[] = [],
  availableActors: { src: string; fsmType?: string; fsmVersion?: string }[] = [],
) {
  if (folderPath.startsWith(".")) {
    throw new Error(
      `Invalid folder path: ${folderPath}. Folder paths cannot start with '.'`,
    );
  }
  if (folderPath.endsWith("/")) {
    throw new Error(
      `Invalid folder path: ${folderPath}. Folder paths cannot end with '/'`,
    );
  }
  if (folderPath.startsWith("/")) {
    console.log(`Importing workflows from absolute path: ${folderPath}`);
  } else {
    console.log(
      `Importing workflows from relative path: ${folderPath} to ${Deno.cwd()}`,
    );
  }
  const absFolderPath = folderPath.startsWith("/")
    ? folderPath
    : `${Deno.cwd()}/${folderPath}`;

  const allFolderResults = [];
  // check if absFolderPath exists and is a directory
  try {
    const stat = await Deno.stat(absFolderPath);
    if (!stat.isDirectory) {
      throw new Error(`Provided path '${absFolderPath}' is not a directory.`);
    }
    for await (const dirEntry of Deno.readDir(absFolderPath)) {
      if (dirEntry.isDirectory) {
        if (skipDirs.includes(dirEntry.name)) {
          continue;
        }

        const fsmDirPath = `${absFolderPath}/${dirEntry.name}`;

        for await (const subEntry of Deno.readDir(fsmDirPath)) {
          if (subEntry.isDirectory) {
            if (isVersionFolderName(subEntry.name)) {

              try {
                const fsmJson = `${fsmDirPath}/${subEntry.name}/fsm.json`;
                await Deno.stat(fsmJson);

                // Load fsm.json for DB ingestion
                const fsmData = JSON.parse(await Deno.readTextFile(fsmJson));
                const rootNodeText = null;
                const fsmResult = await loadFsmFromJsonV2(deps, fsmData, rootNodeText, dirEntry.name, subEntry.name);
                console.log(`Successfully loaded FSM from ${fsmJson}:`, fsmResult);

                const folderResult = await validateFsmPluginLoadFromFolder(
                  fsmData,
                  dirEntry.name,
                  subEntry.name,
                  `${fsmDirPath}/${subEntry.name}`,
                  `${dirEntry.name}/${subEntry.name}`,
                  folderPath,
                  absFolderPath,
                  folderPath,
                  workflow_type,
                  availableActors,
                );

                console.log(
                  `Validation result for ${dirEntry.name}/${subEntry.name}:`,
                  folderResult,
                );

                allFolderResults.push({ ...folderResult, ...(fsmResult as object) });

              } catch (err) {
                if (err instanceof Deno.errors.NotFound) {
                  console.log(`fsm.json is missing in ${fsmDirPath}/${subEntry.name}`);
                } else {
                  console.error(`Failed to import or process ${fsmDirPath}/${subEntry.name}:`, err);
                }
              }  
             
            } else {
              console.log(
                `Skipping non-versioned folder: ${subEntry.name} in ${fsmDirPath}`,
              );
            }
          }
        }
      }
    }
    console.log("All folder validation results:", allFolderResults);
    
  } catch (err) {
    // throw new Error(`Directory '${absFolderPath}' does not exist.`);
    console.error(`Error occurred while reading directory '${absFolderPath}':`, err);
  }  
  
  return allFolderResults;
}
