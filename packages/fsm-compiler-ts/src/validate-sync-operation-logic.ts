import { getLogger } from "@logtape/logtape";

const logger = getLogger(["@pgfsm/compiler", "validate"]);

import { Ajv } from "ajv";
import machineSchema from "../../database-src/fsm.machine.schema.v3.json" with {
  type: "json",
};
import {
  type ActorReference,
  DELAY_ACTION_NAME_PREFIX,
  type ExternalActor,
  extractFsmPluginRefs,
  type FailedMethod,
  type FsmPluginValidationResult,
  type InternalActor,
  isVersionFolderName,
  RAISE_CANCEL,
  type WorkflowType,
} from "./util.ts";
import type { Json } from "@pgfsm/db/database.types";

export const isFunction = (v: unknown): v is Function =>
  typeof v === "function";

export const hasArity = (n: number) => (fn: unknown): boolean =>
  isFunction(fn) && fn.length === n;

export async function validateLanguageModules(
  absFolderPath: string,
  lang: string,
  actions: string[],
  guards: string[],
  delays: string[],
) {
  const failedMethods: FailedMethod[] = [];

  const filteredActions = actions.filter((a) => !RAISE_CANCEL.has(a));
  const prefixedDelays = delays.map((d) => `${DELAY_ACTION_NAME_PREFIX}${d}`);
  const moduleTypes = [
    { type: "actions", names: filteredActions },
    { type: "guards", names: guards },
    { type: "delays", names: prefixedDelays },
  ];

  const modules: Record<string, any> = {
    actions: null,
    guards: null,
    delays: null,
    actors: null,
  };

  for (const modType of moduleTypes) {
    const modDir = `${absFolderPath}/${lang}/${modType.type}`;
    const modulePath = `${modDir}/index.ts`;
    try {
      const mod = await import(`file://${modulePath}`);
      modules[modType.type] = mod;
      for (const name of modType.names) {
        if (typeof mod[name] !== "function") {
          logger.info("{moduleType} does not export {name} as a function", {
            moduleType: modType.type,
            name,
          });
          failedMethods.push({
            method: name,
            moduleType: modType.type,
            modulePath: modulePath,
          });
        } else {
          logger.info("{moduleType} exports {name} as a function", {
            moduleType: modType.type,
            name,
          });
        }
      }
    } catch (err) {
      logger.error(
        "Failed to import module for {moduleType} from {modulePath}: {error}",
        { moduleType: modType.type, modulePath, error: err },
      );
      modules[modType.type] = null;
      for (const name of modType.names) {
        failedMethods.push({
          method: name,
          moduleType: modType.type,
          modulePath: modulePath,
        });
      }
    }
  }

  return {
    modules,
    failedMethods,
  };
}

export async function validateSyncOperationFromFolder(
  fsmData: Json,
  dirName: string,
  versionName: string,
  absPath: string,
  relPath: string,
  parentDirName: string,
  parentAbsPath: string,
  parentRelPath: string,
  workflowType: WorkflowType,
  availableActors: ActorReference[],
): Promise<FsmPluginValidationResult> {
  let fsmJsonPresent = true;
  let fsmJsonConfigData: any = undefined;
  let fsmJsonFollowSchema = false;
  let fsmModuleDefinition: any = undefined;
  let isFsmModuleVerified = false;
  let failedMethods: FailedMethod[] = [];
  let actions: string[] = [];
  let guards: string[] = [];
  let delays: string[] = [];
  let asyncOperationActors: any[] = [];

  const ajv = new Ajv({ allErrors: true, strict: true, verbose: true });
  const validate = ajv.compile(machineSchema);
  const valid = validate(fsmData);
  fsmJsonFollowSchema = !!valid;
  if (!valid) {
    logger.error("fsm.json validation failed: {errors}", {
      errors: validate.errors,
    });
    return {
      src: dirName,
      fsmName: dirName,
      fsmVersion: versionName,
      fsmType: workflowType,
      fsmAbsFolderPath: absPath,
      fsmRelativeFolderPath: relPath,
      fsmParentDirName: parentDirName,
      fsmParentAbsFolderPath: parentAbsPath,
      fsmParentRelativeFolderPath: parentRelPath,
      fsmJsonPresent,
      fsmJsonConfigData,
      fsmJsonFollowSchema,
      isFsmModuleVerified,
      fsmModuleDefinition,
      failedMethods,
      asyncOperationActors,
    };
  }

  const result = extractFsmPluginRefs(fsmData);
  actions = result.actions;
  guards = result.guards;
  delays = result.delays;
  asyncOperationActors = result.actors;

  const outputValidateLanguageModules = await validateLanguageModules(
    absPath,
    "typescript",
    actions,
    guards,
    delays,
  );
  failedMethods = outputValidateLanguageModules.failedMethods;
  fsmModuleDefinition = outputValidateLanguageModules.modules;

  isFsmModuleVerified = failedMethods.length === 0;

  return {
    src: dirName,
    fsmName: dirName,
    fsmVersion: versionName,
    fsmType: workflowType,
    fsmAbsFolderPath: absPath,
    fsmRelativeFolderPath: relPath,
    fsmParentDirName: parentDirName,
    fsmParentAbsFolderPath: parentAbsPath,
    fsmParentRelativeFolderPath: parentRelPath,
    fsmJsonPresent,
    fsmJsonConfigData: fsmData,
    fsmJsonFollowSchema,
    isFsmModuleVerified,
    fsmModuleDefinition,
    failedMethods,
    asyncOperationActors,
  };
}

export async function validateSyncOperationFromFolders(
  folderPath: string,
  workflowType: WorkflowType,
  skipDirs: string[] = [],
  availableActors: ActorReference[] = [],
): Promise<FsmPluginValidationResult[]> {
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
              try {
                const fsmJsonPath = `${fsmDirPath}/${subEntry.name}/fsm.json`;
                await Deno.stat(fsmJsonPath);
                const fsmData = JSON.parse(
                  await Deno.readTextFile(fsmJsonPath),
                );

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

                allFolderResults.push(folderResult);
              } catch (err) {
                logger.error("Failed to validate {path}: {error}", {
                  path: `${fsmDirPath}/${subEntry.name}`,
                  error: err,
                });
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
