import { getLogger } from "@logtape/logtape";
import { v4 as uuidv4 } from "uuid";
import { writeFileSync } from "node:fs";

const logger = getLogger(["@pgfsm/compiler", "generate"]);
import { Ajv } from "ajv";
import machineSchema from "../../database-src/fsm.machine.schema.v2.json" with { type: "json" };
import { DELAY_ACTION_NAME_PREFIX, RAISE_CANCEL, isVersionFolderName, type WorkflowType } from "./util.ts";
import type { Json } from "@pgfsm/db/database.types";

/**
 * Pure function — returns a new FSM JSON object with all null values removed
 * from every entry/exit/initial/on/transitions actions array. Does not mutate the input.
 * @param obj The FSM JSON object
 * @returns A new object with nulls removed from all actions arrays
 */
function removeNullActions(obj: any): any {
  const clone = JSON.parse(JSON.stringify(obj));

  function filterNulls(arr: any[]): any[] {
    return arr.filter((a: any) => a !== null);
  }

  function visitState(state: any) {
    if (Array.isArray(state.entry)) state.entry = filterNulls(state.entry);
    if (Array.isArray(state.exit)) state.exit = filterNulls(state.exit);

    if (state.initial && Array.isArray(state.initial.actions)) {
      state.initial.actions = filterNulls(state.initial.actions);
    }

    if (state.on && typeof state.on === "object") {
      for (const eventKey of Object.keys(state.on)) {
        const transitions = state.on[eventKey];
        if (Array.isArray(transitions)) {
          for (const transition of transitions) {
            if (Array.isArray(transition.actions)) {
              transition.actions = filterNulls(transition.actions);
            }
          }
        }
      }
    }
    if (Array.isArray(state.transitions)) {
      for (const transition of state.transitions) {
        if (Array.isArray(transition.actions)) {
          transition.actions = filterNulls(transition.actions);
        }
      }
    }

    if (state.states && typeof state.states === "object") {
      for (const subKey of Object.keys(state.states)) visitState(state.states[subKey]);
    }
  }

  visitState(clone);
  return clone;
}

/**
 * Pure function — returns a new FSM JSON with every plain string action
 * converted to an actionObject `{ type: string }` in all entry/exit arrays
 * and transition actions arrays. Does not mutate the input.
 * @param obj The FSM JSON object
 * @returns A new object with all string actions replaced by { type: string }
 */
export function normalizeActionsToObjects(obj: Json): Json {
  const clone = JSON.parse(JSON.stringify(obj));

  function toActionObject(a: any): any {
    return typeof a === "string" ? { type: a } : a;
  }

  function normalizeActionArray(arr: any[]): any[] {
    return arr.map(toActionObject);
  }

  function visitState(state: any) {
    if (Array.isArray(state.entry)) state.entry = normalizeActionArray(state.entry);
    if (Array.isArray(state.exit)) state.exit = normalizeActionArray(state.exit);

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

    if (state.states && typeof state.states === "object") {
      for (const subKey of Object.keys(state.states)) visitState(state.states[subKey]);
    }
  }

  visitState(clone);
  return clone;
}

/**
 * Pure function — for every xstate.raise/xstate.cancel action in a state's entry/exit arrays,
 * sets actionName from the delay values of that state's "xstate.after." transitions.
 * Only acts on entry and exit. Does not mutate the input.
 * @param obj The FSM JSON object
 * @returns A new object with actionName populated on matching entry/exit actions
 */
export function addActionNameFromDelay(obj: Json): Json {
  const clone = JSON.parse(JSON.stringify(obj));

  /** Collect full transition objects whose event contains "xstate.after." and have a delay key */
  function getAfterTransitions(state: any): any[] {
    const afterTransitions: any[] = [];

    if (state.on && typeof state.on === "object") {
      for (const eventKey of Object.keys(state.on)) {
        if (eventKey.includes("xstate.after.")) {
          const transitions = state.on[eventKey];
          if (Array.isArray(transitions)) {
            for (const t of transitions) {
              if ("delay" in t) afterTransitions.push(t);
            }
          }
        }
      }
    }

    if (Array.isArray(state.transitions)) {
      for (const t of state.transitions) {
        if (typeof t.eventType === "string" && t.eventType.includes("xstate.after.") && "delay" in t) {
          afterTransitions.push(t);
        }
      }
    }

    return afterTransitions;
  }

  /** Map each xstate.raise/xstate.cancel action to the next after-transition's delay value */
  function enrichActionArray(actions: any[], afterTransitions: any[]): any[] {
    let i = 0;
    return actions.map((a) => {
      if (a && typeof a === "object" && RAISE_CANCEL.has(a.type) && i < afterTransitions.length) {
        const t = afterTransitions[i++];
        return {
          ...a,
          delayActionName: DELAY_ACTION_NAME_PREFIX + t.delay,
          ...(t.eventType !== undefined && { delayActionEventType: t.eventType }),
        };
      }
      return a;
    });
  }

  function visitState(state: any) {
    const afterTransitions = getAfterTransitions(state);

    if (Array.isArray(state.entry)) state.entry = enrichActionArray(state.entry, afterTransitions);
    if (Array.isArray(state.exit)) state.exit = enrichActionArray(state.exit, afterTransitions);

    if (state.states && typeof state.states === "object") {
      for (const subKey of Object.keys(state.states)) visitState(state.states[subKey]);
    }
  }

  visitState(clone);
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
export function addMissingFsmTypeToInvokeActors(fsmJSON: Json, parentFsmVersion: string): { fulljson: Json, childActorsInfo: Array<{ child_actor_src: string, child_actor_fsmType: string, child_actor_fsmVersion: string }> } {
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


/**
 * Reads machine.ts from absFolderPath, runs the full FSM compilation pipeline,
 * and writes fsm.json + xstate-fsm.json alongside it.
 * @param absFolderPath Absolute path to the versioned FSM directory (e.g. /…/creditCheck/v01)
 * @param version Version string (e.g. "v01") used when filling in missing fsmVersion on invoke actors
 * @param workflowType Workflow type for the FSM
 * @param showRecommendation When true, validates fsm.json against the machine schema and logs issues
 */
export async function generateFsmJSONFromMachineFile(
  absFolderPath: string,
  version: string,
  _workflowType: WorkflowType,
  showRecommendation: boolean = false,
) {
  const machineTsPath = `${absFolderPath}/machine.ts`;
  try {
    await Deno.stat(machineTsPath);
    const module = await import(`file://${machineTsPath}`);
    const machineConfig = module.default;
    if (!machineConfig) {
      logger.error("No valid export found in {path}", { path: machineTsPath });
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

      // step 2 — removeNullActions (pure): strip null entries from all action arrays
      const cleanedJSON = removeNullActions(xstateFsmJSON);

      // step 3 — normalizeActionsToObjects (pure): convert plain string actions to { type: string }
      const normalizedJSON = normalizeActionsToObjects(cleanedJSON);

      // step 4 — addActionNameFromDelay (pure): set actionName from delay on xstate.raise/xstate.cancel actions
      const enrichedJSON = addActionNameFromDelay(normalizedJSON);

      // step 5 — addMissingFsmTypeToInvokeActors (pure): fill in fsmType/fsmVersion on invoke entries
      const { fulljson: fsmJSON } = addMissingFsmTypeToInvokeActors(enrichedJSON, version);

      // step 6 — write fsm.json
      writeFileSync(`${absFolderPath}/fsm.json`, JSON.stringify(fsmJSON, null, 2));

      // step 7 — (optional) validate fsm.json against schema and show recommendations
      if (showRecommendation) {
        const ajv = new Ajv({ allErrors: true, strict: true, verbose: true });
        const validate = ajv.compile(machineSchema);
        const valid = validate(fsmJSON);
        if (!valid) {
          logger.warning("[recommendation] fsm.json schema issues in {path}/fsm.json: {errors}", { path: absFolderPath, errors: validate.errors });
        } else {
          logger.info("[recommendation] fsm.json passes schema validation in {path}", { path: absFolderPath });
        }
      }
    } else {
      logger.error("Export in {path} is not a valid xstate machine config", { path: machineTsPath });
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      logger.info("machine.ts is missing in {path}", { path: absFolderPath });
    } else {
      logger.error("Failed to import or process {path}: {error}", { path: machineTsPath, error: err });
    }
  }
}

/**
 * Reads a raw XState config.json, writes a machine.ts wrapper alongside it,
 * then delegates to generateFsmJSONFromMachineFile to produce fsm.json + xstate-fsm.json.
 *
 * Skips writing machine.ts if one already exists (logs a warning).
 *
 * @param configJsonPath Absolute path to config.json
 * @param workflowType Workflow type for the FSM
 * @param showRecommendation When true, validates fsm.json against the machine schema and logs issues
 */
export async function generateFsmJSONFromConfigFile(
  configJsonPath: string,
  workflowType: WorkflowType,
  showRecommendation: boolean = false,
) {
  const absFolderPath = configJsonPath.replace(/\/config\.json$/, "");
  const version = absFolderPath.split("/").at(-1) ?? "v01";

  let config: Record<string, unknown>;
  try {
    const configText = await Deno.readTextFile(configJsonPath);
    config = JSON.parse(configText);
  } catch (err) {
    logger.error("Failed to read config.json at {path}: {error}", { path: configJsonPath, error: err });
    return;
  }

  const machineTsPath = `${absFolderPath}/machine.ts`;
  try {
    await Deno.stat(machineTsPath);
    logger.warning("machine.ts already exists at {path} — skipping generation, using existing file", { path: machineTsPath });
  } catch {
    // machine.ts does not exist — generate a wrapper from config.json
    const id = typeof config.id === "string" ? config.id : version;
    const machineTsContent = [
      `import config from "./config.json" with { type: "json" };`,
      ``,
      `export default {`,
      `  id: "${id}",`,
      `  config,`,
      `  toJSON() { return config; },`,
      `};`,
      ``,
    ].join("\n");
    await Deno.writeTextFile(machineTsPath, machineTsContent);
    logger.info("Generated machine.ts from config.json at {path}", { path: machineTsPath });
  }

  await generateFsmJSONFromMachineFile(absFolderPath, version, workflowType, showRecommendation);
}


async function generateFsmJSONFromFolder(
  _dirEntryName: string,
  dirEntryNameVersion: string,
  _folderPath: string,
  absFolderPath: string,
  _parentSource: string,
  workflowType: WorkflowType,
  showRecommendation: boolean = false,
) {
  await generateFsmJSONFromMachineFile(absFolderPath, dirEntryNameVersion, workflowType, showRecommendation);
}


export async function generateFsmJSONFromFolders(
  folderPath: string,
  workflowType: WorkflowType,
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
    logger.info("Importing workflows from absolute path: {path}", { path: folderPath });
  } else {
    logger.info("Importing workflows from relative path: {path} to {cwd}", { path: folderPath, cwd: Deno.cwd() });
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
            await generateFsmJSONFromFolder(dirEntry.name, subEntry.name, folderPath, `${fsmDirPath}/${subEntry.name}`, dirEntry.name, workflowType, showRecommendation);
          } else {
            logger.info("Skipping non-versioned folder: {name} in {dir}", { name: subEntry.name, dir: fsmDirPath });
          }
        }
      }
    }
  }
}