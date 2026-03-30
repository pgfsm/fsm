import { v4 as uuidv4 } from "uuid";
import { writeFileSync } from "node:fs";

// Import Ajv for JSON schema validation
import { Ajv } from "ajv";
import machineSchema from "../../database-src/fsm.machine.schema.v2.json" with { type: "json" };
import { isVersionFolderName, type WorkflowType, extractFsmPluginRefs, RAISE_CANCEL, DELAY_ACTION_NAME_PREFIX } from "./util.ts";
import type { Json } from "@fsm/db/database.types";


// validators.ts
export const isFunction = (v: unknown): v is Function =>
  typeof v === "function"

export const hasArity =
  (n: number) =>
  (fn: unknown): boolean =>
    isFunction(fn) && fn.length === n



export async function validateLanguageModules(
  absFolderPath: string,
  lang: string,
  actions: string[],
  guards: string[],
  delays: string[],
  actors: { src: string; fsmType?: string; fsmVersion?: string }[],
) {
  const failedMethods: { method: string; moduleType: string; modulePath: string }[] = [];
  // Plugin folders
  // Filter actors to only those with fsmType === 'promise'
  const filteredActors = actors.filter(a => a.fsmType === 'promise').map(a => a.src);
  const filteredActions = actions.filter(a => !RAISE_CANCEL.has(a));
  const prefixedDelays = delays.map(d => `${DELAY_ACTION_NAME_PREFIX}${d}`);
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
      const mod = await import(modulePath);
      modules[modType.type] = mod;
      for (const name of modType.names) {
        // Check for method implementation
        if (typeof mod[name] !== "function") {
          console.log(
            `${modType.type} does not export '${name}' as a function.`,
          );
          failedMethods.push({ method: name, moduleType: modType.type, modulePath: modulePath });
        } else {
          console.log(
            `${modType.type} exports '${name}' as a function.`,
          );
        }
      }
    } catch (err) {
      console.error(
        `Failed to import module for ${modType.type} from ${modulePath}:`,
        err,
      );
      modules[modType.type] = null;
      // If module import fails, all methods in this moduleType are considered failed
      for (const name of modType.names) {
        failedMethods.push({ method: name, moduleType: modType.type, modulePath: modulePath });
      }
    }
  }
  
  return {
    modules,
    failedMethods,
  };
}

export async function validatePromisePluginLoadFromFolder(
  fsmDirName: string,
  fsmVersionDirName: string,
  fsmAbsFolderPath: string,
  fsmRelativeFolderPath: string,
  fsmParentDirName: string,
  fsmParentAbsFolderPath: string,
  fsmParentRelativeFolderPath: string,
  workflow_type: WorkflowType,
  availableActors: { src: string; fsmType?: string; fsmVersion?: string }[],
) {
  let fsmJsonPresent = false;
  let fsmJsonFollowSchema = false;
  let fsmModuleDefinition: any = undefined;
  let isFsmModuleVerified = false;
  let requiredChildActors: { src: string; fsmType: string; fsmVersion: string }[] = [];
  let externalActors: { src: string; fsmType: string; fsmVersion: string, resolved: boolean }[] = [];
  let failedMethods: { method: string; moduleType: string; modulePath: string }[] = [];

  console.warn(`Skipping plugin validation for sharedPromise ${fsmDirName}/${fsmVersionDirName} since it is only used as a dependency and not directly invoked.`);
  const lang = "typescript";

  const modDir = `${fsmAbsFolderPath}/${lang}`;
  const modulePath = `${modDir}/index.ts`;
  try {
    const mod = await import(modulePath);

    if (typeof mod[fsmDirName] !== "function") {
      console.log(`sharedPromise does not export '${fsmDirName}' as a function.`);
      failedMethods.push({ method: fsmDirName, moduleType: "sharedPromise", modulePath });
    } else {
      console.log(`sharedPromise exports '${fsmDirName}' as a function.`);
      fsmModuleDefinition = mod;
      isFsmModuleVerified = true;
    }

  } catch (err) {
    console.error(`Failed to import module for sharedPromise from ${modulePath}:`, err);
    failedMethods.push({ method: fsmDirName, moduleType: "sharedPromise", modulePath });
  }

  return {
    src: fsmDirName,
    fsmName: fsmDirName,
    fsmVersion: fsmVersionDirName,
    fsmType: workflow_type,
    fsmAbsFolderPath,
    fsmRelativeFolderPath,
    fsmParentDirName,
    fsmParentAbsFolderPath,
    fsmParentRelativeFolderPath,
    fsmJsonPresent,
    fsmJsonFollowSchema,
    isFsmModuleVerified,
    fsmModuleDefinition,
    failedMethods,
    requiredChildActors,
    externalActors,
  };
}

export async function validatePromisePluginLoadFromFolders(
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

export async function validateFsmPluginLoadFromFolder(
  fsmData: Json,
  fsmDirName: string,
  fsmVersionDirName: string,
  fsmAbsFolderPath: string,
  fsmRelativeFolderPath: string,
  fsmParentDirName: string,
  fsmParentAbsFolderPath: string,
  fsmParentRelativeFolderPath: string,
  workflow_type: WorkflowType,
  availableActors: { src: string; fsmType?: string; fsmVersion?: string }[],
) {
  let fsmJsonPresent = true;
  let fsmJsonFollowSchema = false;
  let fsmModuleDefinition: any = undefined;
  let isFsmModuleVerified = false;
  let requiredChildActors: { src: string; fsmType: string; fsmVersion: string }[] = [];
  let externalActors: { src: string; fsmType: string; fsmVersion: string, resolved: boolean }[] = [];
  let failedMethods: { method: string; moduleType: string; modulePath: string }[] = [];
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
    console.error("fsm.json validation failed:", validate.errors);
    return {
      src: fsmDirName,
      fsmName: fsmDirName,
      fsmVersion: fsmVersionDirName,
      fsmType: workflow_type,
      fsmAbsFolderPath,
      fsmRelativeFolderPath,
      fsmParentDirName,
      fsmParentAbsFolderPath,
      fsmParentRelativeFolderPath,
      fsmJsonPresent,
      fsmJsonFollowSchema,
      isFsmModuleVerified,
      fsmModuleDefinition,
      failedMethods,
      requiredChildActors,
      externalActors,
    };
  }

  // 1.1 Call fn to get all actions and guards from json file
  const result = extractFsmPluginRefs(fsmData);
  actions = result.actions;
  guards = result.guards;
  delays = result.delays;
  actors = result.actors;
  requiredChildActors = [...actors];
  externalActors = requiredChildActors.filter(actor => actor.fsmType !== 'promise').map(actor => ({ ...actor, resolved: false }));

  const outputValidateLanguageModules = await validateLanguageModules(
    fsmAbsFolderPath,
    "typescript",
    actions,
    guards,
    delays,
    actors,
  );
  failedMethods = outputValidateLanguageModules.failedMethods;
  fsmModuleDefinition = outputValidateLanguageModules.modules;

  for (const dependency of externalActors) {
    const isDependencyFound = availableActors.some(folderObj =>
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
      console.error(
        `Missing dependency: ${expectedFolderPath} (fsmType: ${dependency.fsmType}) required by ${fsmDirName}/${fsmVersionDirName}`,
      );
      failedMethods.push({
        method: `${dependency.src}/${dependency.fsmVersion}`,
        moduleType: dependency.fsmType,
        modulePath: "N/A - missing dependency",
      });
    }
  }

  isFsmModuleVerified = failedMethods.length === 0;

  return {
    src: fsmDirName,
    fsmName: fsmDirName,
    fsmVersion: fsmVersionDirName,
    fsmType: workflow_type,
    fsmAbsFolderPath,
    fsmRelativeFolderPath,
    fsmParentDirName,
    fsmParentAbsFolderPath,
    fsmParentRelativeFolderPath,
    fsmJsonPresent,
    fsmJsonFollowSchema,
    isFsmModuleVerified,
    fsmModuleDefinition,
    failedMethods,
    requiredChildActors,
    externalActors,
  };
}

export async function validateFsmPluginLoadFromFolders(
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
                const fsmJsonPath = `${fsmDirPath}/${subEntry.name}/fsm.json`;
                await Deno.stat(fsmJsonPath);
                const fsmData = JSON.parse(await Deno.readTextFile(fsmJsonPath));

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

                allFolderResults.push(folderResult);
              } catch (err) {
                console.error(`Failed to validate ${fsmDirPath}/${subEntry.name}:`, err);
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
