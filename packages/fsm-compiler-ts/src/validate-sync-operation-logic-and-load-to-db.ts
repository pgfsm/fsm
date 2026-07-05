import { getLogger } from "@logtape/logtape";

const logger = getLogger(["@pgfsm/compiler", "validate"]);

import {
  type ActorReference,
  isVersionFolderName,
  type WorkflowType,
} from "./util.ts";

import { validateSyncOperationFromFolder } from "./validate-sync-operation-logic.ts";
import { type DBDeps, loadFsmFromJson } from "@pgfsm/db";

export async function validateSyncOperationAndLoadToDb(
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
    logger.info("Importing workflows from absolute path: {path}", {
      path: folderPath,
    });
  } else {
    logger.info("Importing workflows from relative path: {path} to {cwd}", {
      path: folderPath,
      cwd: Deno.cwd(),
    });
  }
  const absFolderPath = folderPath.startsWith("/")
    ? folderPath
    : `${Deno.cwd()}/${folderPath}`;

  const allFolderResults = [];
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

                const folderResult = await validateSyncOperationFromFolder(
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

                logger.info("Validation result for {dir}/{sub}: {result}", {
                  dir: dirEntry.name,
                  sub: subEntry.name,
                  result: folderResult,
                });

                if (folderResult.isFsmModuleVerified) {
                  const fsmResult = await loadFsmFromJson(
                    deps,
                    fsmData,
                    null,
                    workflowType,
                    dirEntry.name,
                    subEntry.name,
                  );
                  logger.info(
                    "Successfully loaded FSM from {path}: {result}",
                    { path: fsmJson, result: fsmResult },
                  );
                  allFolderResults.push({
                    ...folderResult,
                    ...(fsmResult != null && typeof fsmResult === "object"
                      ? fsmResult
                      : {}),
                  });
                } else {
                  allFolderResults.push(folderResult);
                }
              } catch (err) {
                if (err instanceof Deno.errors.NotFound) {
                  logger.info("fsm.json is missing in {path}", {
                    path: `${fsmDirPath}/${subEntry.name}`,
                  });
                } else {
                  logger.error("Failed to import or process {path}: {error}", {
                    path: `${fsmDirPath}/${subEntry.name}`,
                    error: err,
                  });
                }
              }
            } else {
              logger.info("Skipping non-versioned folder: {name} in {dir}", {
                name: subEntry.name,
                dir: fsmDirPath,
              });
            }
          }
        }
      }
    }
    logger.info("All folder validation results: {results}", {
      results: allFolderResults,
    });
  } catch (err) {
    logger.error("Error occurred while reading directory {path}: {error}", {
      path: absFolderPath,
      error: err,
    });
  }

  return allFolderResults;
}
