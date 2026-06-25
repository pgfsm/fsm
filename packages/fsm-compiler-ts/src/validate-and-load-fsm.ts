import { getLogger } from "@logtape/logtape";
import { v4 as uuidv4 } from "uuid";
import { writeFileSync } from "node:fs";

const logger = getLogger(["@pgfsm/compiler", "validate"]);

// Import Ajv for JSON schema validation
import Ajv from "ajv";
import machineSchema from "../../database-src/fsm.machine.schema.v2.json" with { type: "json" };
import { isVersionFolderName, type WorkflowType, type ActorReference } from "./util.ts";

import { validateFsmPluginLoadFromFolder } from "./validate-fsm-plugin-load.ts";
import { validatePromisePluginLoadFromFolder } from "./validate-fsm-plugin-load.ts";
import { loadFsmFromJson, type DBDeps } from "@pgfsm/db";

export async function validateAndLoadPromiseFromFolders(
  deps: DBDeps,
  folderPath: string,
  workflowType: WorkflowType,
  skipDirs: string[] = [],
  availableActors: ActorReference[] = [],
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
    logger.info("Importing workflows from absolute path: {path}", { path: folderPath });
  } else {
    logger.info("Importing workflows from relative path: {path} to {cwd}", { path: folderPath, cwd: Deno.cwd() });
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
                `${dirEntry.name}/${subEntry.name}`,
                folderPath,
                absFolderPath,
                folderPath,
                workflowType,
                availableActors,
              );
              logger.info("Validation result for {dir}/{sub}: {result}", { dir: dirEntry.name, sub: subEntry.name, result: folderResult });
              
              allFolderResults.push(folderResult);
            } else {
              logger.info("Skipping non-versioned folder: {name} in {dir}", { name: subEntry.name, dir: fsmDirPath });
            }
          }
        }
      }
    }
    logger.info("All folder validation results: {results}", { results: allFolderResults });
    
  } catch (err) {
    // throw new Error(`Directory '${absFolderPath}' does not exist.`);
    logger.error("Error occurred while reading directory {path}: {error}", { path: absFolderPath, error: err });
  }  
  
  return allFolderResults;
}

export async function validateAndLoadFsmFromFolders(
  deps: DBDeps,
  folderPath: string,
  workflowType: WorkflowType,
  skipDirs: string[] = [],
  availableActors: ActorReference[] = [],
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
    logger.info("Importing workflows from absolute path: {path}", { path: folderPath });
  } else {
    logger.info("Importing workflows from relative path: {path} to {cwd}", { path: folderPath, cwd: Deno.cwd() });
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

                const fsmData = JSON.parse(await Deno.readTextFile(fsmJson));

                const folderResult = await validateFsmPluginLoadFromFolder(
                  fsmData,
                  dirEntry.name,
                  subEntry.name,
                  `${fsmDirPath}/${subEntry.name}`,
                  `${dirEntry.name}/${subEntry.name}`,
                  folderPath,
                  absFolderPath,
                  folderPath,
                  workflowType,
                  availableActors,
                );

                logger.info("Validation result for {dir}/{sub}: {result}", { dir: dirEntry.name, sub: subEntry.name, result: folderResult });

                if (folderResult.isFsmModuleVerified) {
                  const fsmResult = await loadFsmFromJson(deps, fsmData, null, workflowType, dirEntry.name, subEntry.name);
                  logger.info("Successfully loaded FSM from {path}: {result}", { path: fsmJson, result: fsmResult });
                  allFolderResults.push({
                    ...folderResult,
                    ...(fsmResult != null && typeof fsmResult === "object" ? fsmResult : {}),
                  });
                } else {
                  allFolderResults.push(folderResult);
                }

              } catch (err) {
                if (err instanceof Deno.errors.NotFound) {
                  logger.info("fsm.json is missing in {path}", { path: `${fsmDirPath}/${subEntry.name}` });
                } else {
                  logger.error("Failed to import or process {path}: {error}", { path: `${fsmDirPath}/${subEntry.name}`, error: err });
                }
              }

            } else {
              logger.info("Skipping non-versioned folder: {name} in {dir}", { name: subEntry.name, dir: fsmDirPath });
            }
          }
        }
      }
    }
    logger.info("All folder validation results: {results}", { results: allFolderResults });

  } catch (err) {
    // throw new Error(`Directory '${absFolderPath}' does not exist.`);
    logger.error("Error occurred while reading directory {path}: {error}", { path: absFolderPath, error: err });
  }

  return allFolderResults;
}
