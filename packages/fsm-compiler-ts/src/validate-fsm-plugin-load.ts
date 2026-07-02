import { getLogger } from "@logtape/logtape";
import { v4 as uuidv4 } from "uuid";
import { writeFileSync } from "node:fs";

const logger = getLogger(["@pgfsm/compiler", "validate"]);

// Import Ajv for JSON schema validation
import { Ajv } from "ajv";
import machineSchema from "../../database-src/fsm.machine.schema.v2.json" with {
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

// validators.ts
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
  actors: ActorReference[],
) {
  const failedMethods: FailedMethod[] = [];
  // Plugin folders
  // Filter actors to only those with fsmType === 'promise'
  const filteredActors = actors.filter((a) => a.fsmType === "promise").map(
    (a) => a.src,
  );
  const filteredActions = actions.filter((a) => !RAISE_CANCEL.has(a));
  const prefixedDelays = delays.map((d) => `${DELAY_ACTION_NAME_PREFIX}${d}`);
  const moduleTypes = [
    { type: "actions", names: filteredActions },
    { type: "guards", names: guards },
    { type: "delays", names: prefixedDelays },
    { type: "actors", names: filteredActors },
  ];

  // Store loaded modules for each type
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
      // Dynamic import of index.ts
      const mod = await import(`file://${modulePath}`);
      modules[modType.type] = mod;
      for (const name of modType.names) {
        // Check for method implementation
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
      // If module import fails, all methods in this moduleType are considered failed
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

export async function validatePromisePluginLoadFromFolder(
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
  let fsmJsonPresent = false;
  let fsmJsonFollowSchema = false;
  let fsmModuleDefinition: any = undefined;
  let isFsmModuleVerified = false;
  let internalActors: InternalActor[] = [];
  let externalActors: ExternalActor[] = [];
  let failedMethods: FailedMethod[] = [];

  logger.warning(
    "Skipping plugin validation for sharedPromise {dirName}/{versionName} since it is only used as a dependency and not directly invoked",
    { dirName, versionName },
  );
  const lang = "typescript";

  const modDir = `${absPath}/${lang}`;
  const modulePath = `${modDir}/index.ts`;
  try {
    const mod = await import(`file://${modulePath}`);

    if (typeof mod[dirName] !== "function") {
      logger.info("sharedPromise does not export {name} as a function", {
        name: dirName,
      });
      failedMethods.push({
        method: dirName,
        moduleType: "sharedPromise",
        modulePath,
      });
    } else {
      logger.info("sharedPromise exports {name} as a function", {
        name: dirName,
      });
      fsmModuleDefinition = mod;
      isFsmModuleVerified = true;
    }
  } catch (err) {
    logger.error(
      "Failed to import module for sharedPromise from {modulePath}: {error}",
      { modulePath, error: err },
    );
    failedMethods.push({
      method: dirName,
      moduleType: "sharedPromise",
      modulePath,
    });
  }

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
    fsmJsonFollowSchema,
    isFsmModuleVerified,
    fsmModuleDefinition,
    failedMethods,
    internalActors,
    externalActors,
  };
}

export async function validatePromisePluginLoadFromFolders(
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
    // throw new Error(`Directory '${absFolderPath}' does not exist.`);
    logger.error("Error occurred while reading directory {path}: {error}", {
      path: absFolderPath,
      error: err,
    });
  }

  return allFolderResults;
}

export async function validateFsmPluginLoadFromFolder(
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
  let fsmJsonFollowSchema = false;
  let fsmModuleDefinition: any = undefined;
  let isFsmModuleVerified = false;
  let internalActors: InternalActor[] = [];
  let externalActors: ExternalActor[] = [];
  let failedMethods: FailedMethod[] = [];
  let actions: string[] = [];
  let guards: string[] = [];
  let delays: string[] = [];
  let actors: any[] = [];

  // Validate fsmData structure from json schema
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
      fsmJsonFollowSchema,
      isFsmModuleVerified,
      fsmModuleDefinition,
      failedMethods,
      internalActors,
      externalActors,
    };
  }

  // 1.1 Call fn to get all actions and guards from json file
  const result = extractFsmPluginRefs(fsmData);
  actions = result.actions;
  guards = result.guards;
  delays = result.delays;
  actors = result.actors;
  internalActors = actors.filter((actor) => actor.fsmType === "promise").map(
    (actor) => ({
      ...actor,
      resolved: true,
      fsmName: actor.src,
      fsmAbsFolderPath: absPath,
      fsmRelativeFolderPath: relPath,
    }),
  );
  externalActors = actors.filter((actor) => actor.fsmType !== "promise").map(
    (actor) => ({ ...actor, resolved: false }),
  );

  // Actors are resolved via internalActors/externalActors below; skip module validation here
  const outputValidateLanguageModules = await validateLanguageModules(
    absPath,
    "typescript",
    actions,
    guards,
    delays,
    [],
  );
  failedMethods = outputValidateLanguageModules.failedMethods;
  fsmModuleDefinition = outputValidateLanguageModules.modules;

  for (const dependency of externalActors) {
    const isDependencyFound = availableActors.some((folderObj) =>
      folderObj.src === dependency.src &&
      folderObj.fsmVersion === dependency.fsmVersion &&
      folderObj.fsmType === dependency.fsmType
    );

    if (isDependencyFound) {
      dependency.resolved = true;
    } else {
      const expectedFolderPath = dependency.fsmVersion
        ? `${dependency.src}/${dependency.fsmVersion}`
        : dependency.src;
      logger.error(
        "Missing dependency: {dep} (fsmType: {fsmType}) required by {dirName}/{versionName}",
        {
          dep: expectedFolderPath,
          fsmType: dependency.fsmType,
          dirName,
          versionName,
        },
      );
      failedMethods.push({
        method: `${dependency.src}/${dependency.fsmVersion}`,
        moduleType: dependency.fsmType ?? "unknown",
        modulePath: "N/A - missing dependency",
      });
    }
  }

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
    fsmJsonFollowSchema,
    isFsmModuleVerified,
    fsmModuleDefinition,
    failedMethods,
    internalActors,
    externalActors,
  };
}

export async function validateFsmPluginLoadFromFolders(
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
                const fsmJsonPath = `${fsmDirPath}/${subEntry.name}/fsm.json`;
                await Deno.stat(fsmJsonPath);
                const fsmData = JSON.parse(
                  await Deno.readTextFile(fsmJsonPath),
                );

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
    // throw new Error(`Directory '${absFolderPath}' does not exist.`);
    logger.error("Error occurred while reading directory {path}: {error}", {
      path: absFolderPath,
      error: err,
    });
  }

  return allFolderResults;
}
