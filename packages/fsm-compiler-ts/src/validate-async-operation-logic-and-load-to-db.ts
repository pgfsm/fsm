import { getLogger } from "@logtape/logtape";

const logger = getLogger(["@pgfsm/compiler", "validate"]);

import {
  type ActorReference,
  type FailedMethod,
  type FsmPluginValidationResult,
  isVersionFolderName,
  type WorkflowType,
} from "./util.ts";
import { type OperationLang } from "./operation-logic-scaffold.ts";

import type { DBDeps } from "@pgfsm/db";

export async function validateAsyncOperationAndLoadToDb(
  deps: DBDeps,
  folderPath: string,
  workflowType: WorkflowType,
  skipDirs: string[] = [],
  availableActors: ActorReference[] = [],
  langs: OperationLang[] = [],
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

  const allFolderResults: FsmPluginValidationResult[] = [];
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
              // sharedPromise modules are TypeScript-only: validate that the
              // versioned folder exports the module name as a function.
              const absVersionPath = `${fsmDirPath}/${subEntry.name}`;
              const modulePath = `${absVersionPath}/typescript/index.ts`;
              const failedMethods: FailedMethod[] = [];
              let fsmModuleDefinition: any = undefined;
              let isFsmModuleVerified = false;

              logger.warning(
                "Skipping plugin validation for sharedPromise {dirName}/{versionName} since it is only used as a dependency and not directly invoked",
                { dirName: dirEntry.name, versionName: subEntry.name },
              );

              const shouldValidateTs = langs.length === 0 ||
                langs.includes("typescript");
              if (shouldValidateTs) {
                try {
                  const mod = await import(`file://${modulePath}`);
                  if (typeof mod[dirEntry.name] !== "function") {
                    logger.info(
                      "sharedPromise does not export {name} as a function",
                      { name: dirEntry.name },
                    );
                    failedMethods.push({
                      method: dirEntry.name,
                      moduleType: "sharedPromise",
                      modulePath,
                    });
                  } else {
                    logger.info(
                      "sharedPromise exports {name} as a function",
                      { name: dirEntry.name },
                    );
                    fsmModuleDefinition = mod;
                    isFsmModuleVerified = true;
                  }
                } catch (err) {
                  logger.error(
                    "Failed to import module for sharedPromise from {modulePath}: {error}",
                    { modulePath, error: err },
                  );
                  failedMethods.push({
                    method: dirEntry.name,
                    moduleType: "sharedPromise",
                    modulePath,
                  });
                }
              } else {
                isFsmModuleVerified = true;
              }

              const folderResult: FsmPluginValidationResult = {
                src: dirEntry.name,
                fsmName: dirEntry.name,
                fsmVersion: subEntry.name,
                fsmType: workflowType,
                fsmAbsFolderPath: absVersionPath,
                fsmRelativeFolderPath: `${dirEntry.name}/${subEntry.name}`,
                fsmParentDirName: folderPath,
                fsmParentAbsFolderPath: absFolderPath,
                fsmParentRelativeFolderPath: folderPath,
                fsmJsonPresent: false,
                fsmJsonFollowSchema: false,
                isFsmModuleVerified,
                fsmModuleDefinition,
                failedMethods,
                internalActors: [],
                externalActors: [],
              };

              logger.info("Validation result for {dir}/{sub}: {result}", {
                dir: dirEntry.name,
                sub: subEntry.name,
                result: folderResult,
              });

              allFolderResults.push(folderResult);
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
