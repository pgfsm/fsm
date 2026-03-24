import { v4 as uuidv4 } from "uuid";
import { writeFileSync } from "node:fs";
import Ajv from "ajv";
import machineSchema from "../../database-src/fsm.machine.schema.v1.json" with { type: "json" };
import { isVersionFolderName, type WorkflowType } from "./util.ts";

/**
 * Pure function — returns a new FSM JSON object with all null values removed
 * from every actions/entry/exit array. Does not mutate the input.
 * @param obj The FSM JSON object
 * @returns A new object with nulls removed from actions arrays
 */
function removeNullActions(obj: any): any {
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

/**
 * Pure function — returns a new FSM JSON with every plain string action
 * converted to an actionObject `{ type: string }` in all entry/exit arrays
 * and transition actions arrays. Does not mutate the input.
 * @param obj The FSM JSON object
 * @returns A new object with all string actions replaced by { type: string }
 */
export function normalizeActionsToObjects(obj: any): any {
  const clone = JSON.parse(JSON.stringify(obj));

  function toActionObject(a: any): any {
    return typeof a === "string" ? { type: a } : a;
  }

  function normalizeActionArray(arr: any[]): any[] {
    return arr.map(toActionObject);
  }

  function visitState(state: any) {
    if (Array.isArray(state.entry)) {
      state.entry = normalizeActionArray(state.entry);
    }
    if (Array.isArray(state.exit)) {
      state.exit = normalizeActionArray(state.exit);
    }

    // initial transition actions
    if (state.initial && Array.isArray(state.initial.actions)) {
      state.initial.actions = normalizeActionArray(state.initial.actions);
    }

    if (state.on && typeof state.on === "object") {
      for (const eventKey of Object.keys(state.on)) {
        const transitions = state.on[eventKey];
        if (Array.isArray(transitions)) {
          for (const transition of transitions) {
            if (Array.isArray(transition.actions)) {
              transition.actions = normalizeActionArray(transition.actions);
            }
          }
        }
      }
    }
    if (Array.isArray(state.transitions)) {
      for (const transition of state.transitions) {
        if (Array.isArray(transition.actions)) {
          transition.actions = normalizeActionArray(transition.actions);
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

  // Root-level entry/exit
  if (Array.isArray(clone.entry)) {
    clone.entry = normalizeActionArray(clone.entry);
  }
  if (Array.isArray(clone.exit)) {
    clone.exit = normalizeActionArray(clone.exit);
  }

  // Root initial transition actions
  if (clone.initial && Array.isArray(clone.initial.actions)) {
    clone.initial.actions = normalizeActionArray(clone.initial.actions);
  }

  // Root on transitions
  if (clone.on && typeof clone.on === "object") {
    for (const eventKey of Object.keys(clone.on)) {
      const transitions = clone.on[eventKey];
      if (Array.isArray(transitions)) {
        for (const transition of transitions) {
          if (Array.isArray(transition.actions)) {
            transition.actions = normalizeActionArray(transition.actions);
          }
        }
      }
    }
  }
  if (Array.isArray(clone.transitions)) {
    for (const transition of clone.transitions) {
      if (Array.isArray(transition.actions)) {
        transition.actions = normalizeActionArray(transition.actions);
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

/**
 * Pure function — returns a new FSM JSON with missing fsmType/fsmVersion added
 * to every invoke entry, plus a flat list of all child actor metadata.
 * Does not mutate the input.
 * @param fsmJSON The FSM JSON object
 * @param parentFsmVersion Fallback fsmVersion applied when invoke entry has none
 * @returns { fulljson, childActorsInfo }
 */
export function addMissingFsmTypeToInvokeActor(fsmJSON: any, parentFsmVersion: string): { fulljson: any, childActorsInfo: Array<{ child_actor_src: string, child_actor_fsmType: string, child_actor_fsmVersion: string }> } {
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
  workflow_type: WorkflowType,
  showRecommendation: boolean = false,
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
      // step 1 — export raw XState JSON and write xstate-fsm.json
      const xstateFsmJSON = machineConfig.toJSON();
      writeFileSync(`${absFolderPath}/xstate-fsm.json`, JSON.stringify(xstateFsmJSON, null, 2));
      console.log(`Wrote xstate-fsm.json to ${absFolderPath}/xstate-fsm.json`);

      // step 2 — removeNullActions (pure): strip null entries from all action arrays
      const cleanedJSON = removeNullActions(xstateFsmJSON);

      // step 3 — normalizeActionsToObjects (pure): convert plain string actions to { type: string }
      const normalizedJSON = normalizeActionsToObjects(cleanedJSON);

      // step 4 — addMissingFsmTypeToInvokeActor (pure): fill in fsmType/fsmVersion on invoke entries
      const { fulljson: fsmJSON, childActorsInfo } = addMissingFsmTypeToInvokeActor(normalizedJSON, dirEntryNameVersion);

      // step 5 — write fsm.json
      writeFileSync(`${absFolderPath}/fsm.json`, JSON.stringify(fsmJSON, null, 2));
      console.log(`Wrote fsm.json to ${absFolderPath}/fsm.json`);
      if (childActorsInfo.length > 0) {
        console.log('Child actor info:', childActorsInfo);
      }

      // step 6 — (optional) validate fsm.json against schema and show recommendations
      if (showRecommendation) {
        const ajv = new Ajv({ allErrors: true, strict: true, verbose: true });
        const validate = ajv.compile(machineSchema);
        const valid = validate(fsmJSON);
        if (!valid) {
          console.warn(`[recommendation] fsm.json schema issues in ${absFolderPath}/fsm.json:`);
          for (const err of validate.errors ?? []) {
            console.warn(`  - ${err.instancePath || "/"} ${err.message} (${JSON.stringify(err.params)})`);
          }
        } else {
          console.log(`[recommendation] fsm.json passes schema validation ✓`);
        }
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
  workflow_type: WorkflowType,
  skipDirs: string[] = [],
  showRecommendation: boolean = false,
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
            await generateFsmJSONFromFolder(dirEntry.name, subEntry.name, folderPath, `${fsmDirPath}/${subEntry.name}`, dirEntry.name, workflow_type, showRecommendation);
          } else {
            console.log(`Skipping non-versioned folder: ${subEntry.name} in ${fsmDirPath}`);
          }
        }
      }
    }
  }
}