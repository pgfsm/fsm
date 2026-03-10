import { v4 as uuidv4 } from "uuid";
import { writeFileSync } from "node:fs";
import { isVersionFolderName } from "./util.ts";

/**
 * Removes all null values from any 'actions' array in the FSM JSON object.
 * Uses an iterative approach to avoid recursion depth issues.
 * @param obj The FSM JSON object
 * @returns A new object with nulls removed from actions arrays
 */
function removeNullActions(obj: any): any {
  // Deep clone the object to avoid mutating the original
  const clone = JSON.parse(JSON.stringify(obj));

  function visitState(state: any) {
    // Remove nulls from entry/exit arrays if present
    if (Array.isArray(state.entry)) {
      state.entry = state.entry.filter((a: any) => a !== null);
    }
    if (Array.isArray(state.exit)) {
      state.exit = state.exit.filter((a: any) => a !== null);
    }

    // Remove nulls from actions in transitions (in 'on' and 'transitions')
    if (state.on && typeof state.on === "object") {
      for (const eventKey of Object.keys(state.on)) {
        const transitions = state.on[eventKey];
        if (Array.isArray(transitions)) {
          for (const transition of transitions) {
            if (Array.isArray(transition.actions)) {
              transition.actions = transition.actions.filter((a: any) => a !== null);
            }
          }
        }
      }
    }
    if (Array.isArray(state.transitions)) {
      for (const transition of state.transitions) {
        if (Array.isArray(transition.actions)) {
          transition.actions = transition.actions.filter((a: any) => a !== null);
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

  // Top-level actions in root (rare, but possible)
  if (Array.isArray(clone.actions)) {
    clone.actions = clone.actions.filter((a: any) => a !== null);
  }

  // Remove nulls from actions in root transitions
  if (clone.on && typeof clone.on === "object") {
    for (const eventKey of Object.keys(clone.on)) {
      const transitions = clone.on[eventKey];
      if (Array.isArray(transitions)) {
        for (const transition of transitions) {
          if (Array.isArray(transition.actions)) {
            transition.actions = transition.actions.filter((a: any) => a !== null);
          }
        }
      }
    }
  }
  if (Array.isArray(clone.transitions)) {
    for (const transition of clone.transitions) {
      if (Array.isArray(transition.actions)) {
        transition.actions = transition.actions.filter((a: any) => a !== null);
      }
    }
  }

  // Visit all states recursively
  if (clone.states && typeof clone.states === "object") {
    for (const stateKey of Object.keys(clone.states)) {
      visitState(clone.states[stateKey]);
    }
  }

  return clone;
}

async function deleteFsmJSONFromFolder(
  dirEntryName: string,
  dirEntryNameVersion: string,
  folderPath: string,
  absFolderPath: string,
  parentSource: string,
  workflow_type: "fsm" | "childfsm" | "sharedfsm" | "promise"
) {
  try {
    await Deno.remove(`${absFolderPath}/xstate-fsm.json`);
    await Deno.remove(`${absFolderPath}/fsm.json`);
    console.log(`Deleted xstate-fsm.json and fsm.json from ${absFolderPath}`);
    
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log(`fsm.json or xstate-fsm.json is missing in ${absFolderPath}/${dirEntryName}, nothing to delete`);
    } else {
      console.error(`Failed to delete ${absFolderPath}/fsm.json:`, err);
    }
    
  }
}

export async function deleteFsmJSONFromFolders(
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
             
              await deleteFsmJSONFromFolder(dirEntry.name, subEntry.name, folderPath, `${fsmDirPath}/${subEntry.name}`, dirEntry.name, workflow_type);
            }else {
              console.log(`Skipping non-timestamped folder: ${subEntry.name} in ${fsmDirPath}`);
            }
          }
        }

    }

  }
}

/**
 * Iterates through all invoke entries in the FSM JSON, adds missing fsmType and fsmVersion, and returns full JSON and child actor info array.
 * @param fsmJSON The FSM JSON object
 * @param parentFsmVersion The parent FSM version to use for missing fsmVersion
 * @returns { fulljson, childActorsInfo }
 */
export function addMissingFsmTypeToInvokeActor(fsmJSON: any, parentFsmVersion: string): { fulljson: any, childActorsInfo: Array<{ child_actor_src: string, child_actor_fsmType: string, child_actor_fsmVersion: string }> } {
  // Deep clone to avoid mutating original
  const clone = JSON.parse(JSON.stringify(fsmJSON));
  const childActorsInfo: Array<{ child_actor_src: string, child_actor_fsmType: string, child_actor_fsmVersion: string }> = [];

  function visitState(state: any) {
    if (Array.isArray(state.invoke)) {
      for (const invokeObj of state.invoke) {
        // Only process if src exists
        if (invokeObj && typeof invokeObj.src === 'string') {
          // Add missing fsmType
          if (!('fsmType' in invokeObj)) {
            invokeObj.fsmType = 'promise';
          }
          // Add missing fsmVersion
          if (!('fsmVersion' in invokeObj)) {
            invokeObj.fsmVersion = parentFsmVersion;
          }
          childActorsInfo.push({
            child_actor_src: invokeObj.src,
            child_actor_fsmType: invokeObj.fsmType,
            child_actor_fsmVersion: invokeObj.fsmVersion
          });
        }
      }
    }
    // Recursively visit substates
    if (state.states && typeof state.states === 'object') {
      for (const subKey of Object.keys(state.states)) {
        visitState(state.states[subKey]);
      }
    }
  }

  // Visit all states recursively
  if (clone.states && typeof clone.states === 'object') {
    for (const stateKey of Object.keys(clone.states)) {
      visitState(clone.states[stateKey]);
    }
  }

  // Also check root-level invoke (rare, but possible)
  if (Array.isArray(clone.invoke)) {
    for (const invokeObj of clone.invoke) {
      if (invokeObj && typeof invokeObj.src === 'string') {
        if (!('fsmType' in invokeObj)) {
          invokeObj.fsmType = 'promise';
        }
        if (!('fsmVersion' in invokeObj)) {
          invokeObj.fsmVersion = parentFsmVersion;
        }
        childActorsInfo.push({
          child_actor_src: invokeObj.src,
          child_actor_fsmType: invokeObj.fsmType,
          child_actor_fsmVersion: invokeObj.fsmVersion
        });
      }
    }
  }

  return { fulljson: clone, childActorsInfo };
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
      const xstateFsmJSON = machineConfig.toJSON();
      const jsonOutput = JSON.stringify(xstateFsmJSON, null, 2);
      writeFileSync(`${absFolderPath}/xstate-fsm.json`, jsonOutput);
      console.log(`Wrote new xstate-fsm.json to ${absFolderPath}/xstate-fsm.json`);
      // todo - remove null from all actions from xstateFsmJSON before writing fsm.json
      const xstateJSONWithoutNull = removeNullActions(xstateFsmJSON);
      // Add version and workflow_type to fsmJSON and collect child actor info
      const { fulljson: fsmJSON, childActorsInfo } = addMissingFsmTypeToInvokeActor(xstateJSONWithoutNull, dirEntryNameVersion);
      writeFileSync(`${absFolderPath}/fsm.json`, JSON.stringify(fsmJSON, null, 2));
      console.log(`Wrote new fsm.json to ${absFolderPath}/fsm.json`);
      // Optionally log child actor info
      if (childActorsInfo.length > 0) {
        console.log('Child actor info:', childActorsInfo);
      }


      
      
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
          if (isVersionFolderName(subEntry.name)) {
            await generateFsmJSONFromFolder(dirEntry.name, subEntry.name, folderPath, `${fsmDirPath}/${subEntry.name}`, dirEntry.name, workflow_type);
          } else {
            console.log(`Skipping non-versioned folder: ${subEntry.name} in ${fsmDirPath}`);
          }
        }
      }
    }
  }
}