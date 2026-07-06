import { getLogger } from "@logtape/logtape";

const logger = getLogger(["@pgfsm/compiler", "validate"]);

import { Ajv } from "ajv";
import machineSchema from "../../database-src/fsm.machine.schema.v3.json" with {
  type: "json",
};
import {
  type ActorReference,
  extractFsmPluginRefs,
  type FsmPluginValidationResult,
  isVersionFolderName,
  type WorkflowType,
} from "./util.ts";
import { type OperationLang } from "./operation-logic-scaffold.ts";
import { validateAsyncOperationFromFolder } from "./validate-async-operation-logic.ts";
import { loadAsyncOperation } from "@pgfsm/db";
import type { DBDeps } from "@pgfsm/db";
import type { Json } from "@pgfsm/db/database.types";

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

  const ajv = new Ajv({ allErrors: true, strict: true, verbose: true });
  const validateSchema = ajv.compile(machineSchema);

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
              const absVersionPath = `${fsmDirPath}/${subEntry.name}`;
              try {
                // 1. Read and AJV-validate fsm.json
                const fsmJsonPath = `${absVersionPath}/fsm.json`;
                await Deno.stat(fsmJsonPath);
                const fsmData: Json = JSON.parse(
                  await Deno.readTextFile(fsmJsonPath),
                );

                const schemaValid = validateSchema(fsmData);
                if (!schemaValid) {
                  logger.error(
                    "fsm.json schema validation failed for {name}/{version}: {errors}",
                    {
                      name: dirEntry.name,
                      version: subEntry.name,
                      errors: validateSchema.errors,
                    },
                  );
                  continue;
                }

                // 2. Validate actor exports per fsmLanguage via runtime checkers
                const folderResult = await validateAsyncOperationFromFolder(
                  fsmData,
                  dirEntry.name,
                  subEntry.name,
                  absVersionPath,
                  `${dirEntry.name}/${subEntry.name}`,
                  folderPath,
                  absFolderPath,
                  folderPath,
                  workflowType,
                  availableActors,
                  langs,
                );
                folderResult.fsmJsonPresent = true;
                folderResult.fsmJsonFollowSchema = true;

                logger.info(
                  "Validation result for {dir}/{sub}: {result}",
                  {
                    dir: dirEntry.name,
                    sub: subEntry.name,
                    result: folderResult,
                  },
                );

                // 3. Load each actor into PostgreSQL only when all actors verified
                if (folderResult.isFsmModuleVerified) {
                  const { actors } = extractFsmPluginRefs(fsmData as any);
                  for (const actor of actors) {
                    const loadResult = await loadAsyncOperation(
                      deps,
                      actor.src,
                      actor.fsmVersion ?? subEntry.name,
                      actor.fsmType ?? workflowType,
                      actor.fsmLanguage ?? "typescript",
                      dirEntry.name,
                      subEntry.name,
                    );
                    logger.info(
                      "Loaded async operation for actor {src} in {dir}/{sub}: {result}",
                      {
                        src: actor.src,
                        dir: dirEntry.name,
                        sub: subEntry.name,
                        result: loadResult,
                      },
                    );
                  }
                } else {
                  logger.warning(
                    "Skipping DB load for {dir}/{sub}: actor verification failed",
                    { dir: dirEntry.name, sub: subEntry.name },
                  );
                }

                allFolderResults.push(folderResult);
              } catch (err) {
                logger.error(
                  "Failed to validate/load {path}: {error}",
                  { path: absVersionPath, error: err },
                );
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
