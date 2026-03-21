import { v4 as uuidv4 } from "uuid";
import { writeFileSync } from "node:fs";

// Import Ajv for JSON schema validation
import Ajv from "ajv";
import machineSchema from "../../database-src/fsm.machine.schema.json" with { type: "json" };
import { isVersionFolderName } from "./util.ts";


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
  const moduleTypes = [
    { type: "actions", names: actions },
    { type: "guards", names: guards },
    { type: "delays", names: delays },
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
    actions: modules.actions,
    guards: modules.guards,
    delays: modules.delays,
    actors: modules.actors,
    failedMethods,
  };
}

// Helper: Extract actions and guards from FSM JSON
function getActionsAndGuardsFromFsmJson(fsmData: any): {
  actions: string[];
  guards: string[];
  delays: string[];
  actors: { src: string; fsmType?: string; fsmVersion?: string }[];
} {
  // Recursively traverse the FSM JSON to collect all action, guard, delay, and actor names
  const actionsSet = new Set<string>();
  const guardsSet = new Set<string>();
  const delaysSet = new Set<string>();
  const actorsArr: { src: string; fsmType?: string; fsmVersion?: string }[] = [];

  function visitState(state: any) {
    // Collect actions from entry/exit arrays
    if (Array.isArray(state.entry)) {
      for (const entry of state.entry) {
        if (typeof entry === "string") {
          actionsSet.add(entry);
        } else if (
          entry &&
          typeof entry === "object" &&
          typeof entry.type === "string"
        ) {
          actionsSet.add(entry.type);
        }
      }
    }
    if (Array.isArray(state.exit)) {
      for (const exit of state.exit) {
        if (typeof exit === "string") {
          actionsSet.add(exit);
        } else if (
          exit &&
          typeof exit === "object" &&
          typeof exit.type === "string"
        ) {
          actionsSet.add(exit.type);
        }
      }
    }

    /*
    // Collect actions, guards, delays from transitions (in 'on' and 'transitions')
    if (state.on && typeof state.on === "object") {
      for (const eventKey of Object.keys(state.on)) {
        const transitions = state.on[eventKey];
        if (Array.isArray(transitions)) {
          for (const transition of transitions) {
            // Actions
            if (Array.isArray(transition.actions)) {
              for (const action of transition.actions) {
                if (typeof action === "string") {
                  actionsSet.add(action);
                } else if (
                  action &&
                  typeof action === "object" &&
                  typeof action.type === "string"
                ) {
                  actionsSet.add(action.type);
                }
              }
            }
            // Guards
            if (transition.guard && typeof transition.guard === "string") {
              guardsSet.add(transition.guard);
            }
            // Delays
            if (transition.delay && typeof transition.delay === "string") {
              delaysSet.add(transition.delay);
            }
          }
        }
      }
    }
    */
   
    if (Array.isArray(state.transitions)) {
      for (const transition of state.transitions) {
        // Actions
        if (Array.isArray(transition.actions)) {
          for (const action of transition.actions) {
            if (typeof action === "string") {
              actionsSet.add(action);
            } else if (
              action &&
              typeof action === "object" &&
              typeof action.type === "string"
            ) {
              actionsSet.add(action.type);
            }
          }
        }
        // Guards
        if (transition.guard && typeof transition.guard === "string") {
          guardsSet.add(transition.guard);
        }
        // Delays
        if (transition.delay && typeof transition.delay === "string") {
          delaysSet.add(transition.delay);
        }
      }
    }

    // Collect actors from invoke
    if (Array.isArray(state.invoke)) {
      for (const inv of state.invoke) {
        if (inv && typeof inv.src === "string") {
          actorsArr.push({
            src: inv.src,
            fsmType: inv.fsmType,
            fsmVersion: inv.fsmVersion,
          });
        }
      }
    }

    // Recursively visit substates
    if (state.states && typeof state.states === "object") {
      for (const subKey of Object.keys(state.states)) {
        visitState(state.states[subKey]);
      }
    }
  }

  visitState(fsmData);
  return {
    actions: Array.from(actionsSet).filter(Boolean),
    guards: Array.from(guardsSet).filter(Boolean),
    delays: Array.from(delaysSet).filter(Boolean),
    actors: actorsArr,
  };
}

export async function validateFsmPluginLoadFromFolder(
  dirEntryName: string,
  dirEntryNameVersion: string,
  folderPath: string,
  absFolderPath: string,
  parentSource: string,
  workflow_type: "fsm" | "childfsm" | "sharedfsm" | "promise",
) {
  const fsmJson = `${absFolderPath}/fsm.json`;
  let fsmJsonPresent = false;
  let fsmJsonFollowSchema = false;
  let fsmfsmModuleVerified = false;
  let resultValidateLanguageModules;
  let fsmfailedMethods: { method: string; moduleType: string }[] = [];
  let requiredChildActors: string[] = [];
  let actions: string[] = [];
  let guards: string[] = [];
  let delays: string[] = [];
  let actors: any[] = [];

  try {
    await Deno.stat(fsmJson);
    fsmJsonPresent = true;
    // 1. Load fsm.json file
    const fsmData = JSON.parse(await Deno.readTextFile(fsmJson));

    // Validate fsmData structure from json schema
    const ajv = new Ajv({ allErrors: true, strict: true, verbose: true });
    const validate = ajv.compile(machineSchema);
    const valid = validate(fsmData);
    fsmJsonFollowSchema = !!valid;
    if (!valid) {
      console.error("fsm.json validation failed:", validate.errors);
    }

    // 1.1 Call fn to get all actions and guards from json file
    const result = getActionsAndGuardsFromFsmJson(fsmData);
    actions = result.actions;
    guards = result.guards;
    delays = result.delays;
    actors = result.actors;
    requiredChildActors = [...actors];

    resultValidateLanguageModules  = await validateLanguageModules(
      absFolderPath,
      "typescript",
      actions,
      guards,
      delays,
      actors,
    );

    fsmfsmModuleVerified = resultValidateLanguageModules.failedMethods.length === 0;

  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      fsmJsonPresent = false;
    } else {
      console.error(`Failed to import or process ${fsmJson}:`, err);
    }
  }

  return {
    fsmJsonPresent,
    fsmJsonFollowSchema,
    fsmfsmModuleVerified,
    resultValidateLanguageModules,
    requiredChildActors,
  };
}

export async function validateFsmPluginLoadFromFolders(
  folderPath: string,
  workflow_type: "fsm" | "childfsm" | "sharedfsm" | "promise",
   skipDirs: string[] = []
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
  for await (const dirEntry of Deno.readDir(absFolderPath)) {
    if (dirEntry.isDirectory) {
      if (skipDirs.includes(dirEntry.name)) {
        continue;
      }

      const fsmDirPath = `${absFolderPath}/${dirEntry.name}`;

      for await (const subEntry of Deno.readDir(fsmDirPath)) {
        if (subEntry.isDirectory) {
          if (isVersionFolderName(subEntry.name)) {
            const folderResult = await validateFsmPluginLoadFromFolder(
              dirEntry.name,
              subEntry.name,
              folderPath,
              `${fsmDirPath}/${subEntry.name}`,
              dirEntry.name,
              workflow_type,
            );
            console.log(
              `Validation result for ${dirEntry.name}/${subEntry.name}:`,
              folderResult,
            );
            const dependentActors = folderResult.requiredChildActors.filter(actor => actor.fsmType !== 'promise').map(actor =>  (actor.fsmVersion + "/" + actor.src));
            allFolderResults.push({
              folder: `${dirEntry.name}/${subEntry.name}`,
              result: folderResult,
              dependentActors: dependentActors,
            });
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
  // iterate over allFolderResults and check if dependentActors has any src that is not present as a folder in allFolderResults. If so, log an error with the missing dependency and the folder that requires it.
  const allFolders = allFolderResults.map(r => r.folder);
  for (const folderResult of allFolderResults) {
    for (const dependency of folderResult.dependentActors) {
      if (!allFolders.includes(dependency)) {
        console.error(
          `Missing dependency: ${dependency} required by ${folderResult.folder}`,
        );
      }
    }
  }
}
