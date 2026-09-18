import { getLogger } from "@logtape/logtape";
import { writeFileSync } from "node:fs";

const logger = getLogger(["@pgfsm/compiler", "generate"]);
import { Ajv } from "ajv";
import machineSchema from "../../database-src/fsm.machine.schema.v3.json" with {
  type: "json",
};
import {
  DELAY_ACTION_NAME_PREFIX,
  isVersionFolderName,
  RAISE_CANCEL,
} from "./util.ts";
import type { AnyStateNodeDefinition } from "xstate";
import type {
  ActionObject,
  FsmDraftAction,
  FsmDraftInvoke,
  FsmDraftStateNode,
  FsmDraftTransition,
  WorkflowType,
} from "./types/index.ts";

/**
 * Pure function — returns a new FSM JSON object with all null values removed
 * from every entry/exit/initial/on/transitions actions array. Does not mutate the input.
 * @param obj The raw XState machine definition (machineConfig.toJSON())
 * @returns A new object with nulls removed from all actions arrays
 */
function removeNullActions(obj: AnyStateNodeDefinition): FsmDraftStateNode {
  const clone: FsmDraftStateNode = JSON.parse(JSON.stringify(obj));

  // Real .toJSON() output can contain `null` entries for conditionally
  // skipped actions in machine.ts, which FsmDraftAction doesn't admit.
  function filterNulls(arr: FsmDraftAction[]): FsmDraftAction[] {
    return arr.filter((a) => (a as unknown) !== null);
  }

  function visitState(state: FsmDraftStateNode) {
    if (Array.isArray(state.entry)) state.entry = filterNulls(state.entry);
    if (Array.isArray(state.exit)) state.exit = filterNulls(state.exit);

    if (state.initial && Array.isArray(state.initial.actions)) {
      state.initial.actions = filterNulls(state.initial.actions);
    }

    if (state.on) {
      for (const eventKey of Object.keys(state.on)) {
        for (const transition of state.on[eventKey]) {
          if (Array.isArray(transition.actions)) {
            transition.actions = filterNulls(transition.actions);
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

    if (state.states) {
      for (const subKey of Object.keys(state.states)) {
        visitState(state.states[subKey]);
      }
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
export function normalizeActionsToObjects(
  obj: FsmDraftStateNode,
): FsmDraftStateNode {
  const clone: FsmDraftStateNode = JSON.parse(JSON.stringify(obj));

  function toActionObject(a: FsmDraftAction): ActionObject {
    return typeof a === "string" ? { type: a } : a;
  }

  function normalizeActionArray(arr: FsmDraftAction[]): ActionObject[] {
    return arr.map(toActionObject);
  }

  function visitState(state: FsmDraftStateNode) {
    if (Array.isArray(state.entry)) {
      state.entry = normalizeActionArray(state.entry);
    }
    if (Array.isArray(state.exit)) {
      state.exit = normalizeActionArray(state.exit);
    }

    if (state.initial && Array.isArray(state.initial.actions)) {
      state.initial.actions = normalizeActionArray(state.initial.actions);
    }

    if (state.on) {
      for (const eventKey of Object.keys(state.on)) {
        for (const transition of state.on[eventKey]) {
          if (Array.isArray(transition.actions)) {
            transition.actions = normalizeActionArray(transition.actions);
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

    if (state.states) {
      for (const subKey of Object.keys(state.states)) {
        visitState(state.states[subKey]);
      }
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
export function addActionNameFromDelay(
  obj: FsmDraftStateNode,
): FsmDraftStateNode {
  const clone: FsmDraftStateNode = JSON.parse(JSON.stringify(obj));

  /** Collect full transition objects whose event contains "xstate.after." and have a delay key */
  function getAfterTransitions(
    state: FsmDraftStateNode,
  ): FsmDraftTransition[] {
    const afterTransitions: FsmDraftTransition[] = [];

    if (state.on) {
      for (const eventKey of Object.keys(state.on)) {
        if (eventKey.includes("xstate.after.")) {
          for (const t of state.on[eventKey]) {
            if ("delay" in t) afterTransitions.push(t);
          }
        }
      }
    }

    if (Array.isArray(state.transitions)) {
      for (const t of state.transitions) {
        if (
          typeof t.eventType === "string" &&
          t.eventType.includes("xstate.after.") && "delay" in t
        ) {
          afterTransitions.push(t);
        }
      }
    }

    return afterTransitions;
  }

  /** Map each xstate.raise/xstate.cancel action to the next after-transition's delay value */
  function enrichActionArray(
    actions: FsmDraftAction[],
    afterTransitions: FsmDraftTransition[],
  ): FsmDraftAction[] {
    let i = 0;
    return actions.map((a) => {
      if (
        a && typeof a === "object" && RAISE_CANCEL.has(a.type) &&
        i < afterTransitions.length
      ) {
        const t = afterTransitions[i++];
        return {
          ...a,
          delayActionName: DELAY_ACTION_NAME_PREFIX + t.delay,
          ...(t.eventType !== undefined &&
            { delayActionEventType: t.eventType }),
        };
      }
      return a;
    });
  }

  function visitState(state: FsmDraftStateNode) {
    const afterTransitions = getAfterTransitions(state);

    if (Array.isArray(state.entry)) {
      state.entry = enrichActionArray(state.entry, afterTransitions);
    }
    if (Array.isArray(state.exit)) {
      state.exit = enrichActionArray(state.exit, afterTransitions);
    }

    if (state.states) {
      for (const subKey of Object.keys(state.states)) {
        visitState(state.states[subKey]);
      }
    }
  }

  visitState(clone);
  return clone;
}

/**
 * Pure function — returns a new FSM JSON with missing
 * asyncOperationType/asyncOperationVersion/asyncOperationLanguage added to
 * every invoke entry, plus a flat list of all child actor metadata.
 * asyncOperationLanguage defaults to "typescript" when absent.
 * Does not mutate the input.
 * @param fsmJSON The FSM JSON object
 * @param parentFsmVersion Fallback asyncOperationVersion applied when invoke entry has none
 * @returns { fulljson, childActorsInfo }
 */
export function addMissingAsyncOperationTypeToInvokeActors(
  fsmJSON: FsmDraftStateNode,
  parentFsmVersion: string,
): {
  fulljson: FsmDraftStateNode;
  childActorsInfo: Array<
    {
      child_actor_src: string;
      child_actor_asyncOperationType: string;
      child_actor_asyncOperationVersion: string;
      child_actor_asyncOperationLanguage: string;
    }
  >;
} {
  const clone: FsmDraftStateNode = JSON.parse(JSON.stringify(fsmJSON));
  const childActorsInfo: Array<
    {
      child_actor_src: string;
      child_actor_asyncOperationType: string;
      child_actor_asyncOperationVersion: string;
      child_actor_asyncOperationLanguage: string;
    }
  > = [];

  function fillInvokeDefaults(invokeObj: FsmDraftInvoke) {
    if (!("asyncOperationType" in invokeObj)) {
      invokeObj.asyncOperationType = "internalAsyncOperation";
    }
    if (!("asyncOperationVersion" in invokeObj)) {
      invokeObj.asyncOperationVersion = parentFsmVersion;
    }
    if (!("asyncOperationLanguage" in invokeObj)) {
      invokeObj.asyncOperationLanguage = "typescript";
    }
    if (invokeObj.src) {
      childActorsInfo.push({
        child_actor_src: invokeObj.src,
        child_actor_asyncOperationType: invokeObj.asyncOperationType ??
          "internalAsyncOperation",
        child_actor_asyncOperationVersion: invokeObj.asyncOperationVersion ??
          parentFsmVersion,
        child_actor_asyncOperationLanguage: invokeObj.asyncOperationLanguage ??
          "typescript",
      });
    }
  }

  function visitState(state: FsmDraftStateNode) {
    if (Array.isArray(state.invoke)) {
      for (const invokeObj of state.invoke) {
        if (invokeObj.src) fillInvokeDefaults(invokeObj);
      }
    }
    // Recursively visit substates
    if (state.states) {
      for (const subKey of Object.keys(state.states)) {
        visitState(state.states[subKey]);
      }
    }
  }

  // Visit all states recursively
  if (clone.states) {
    for (const stateKey of Object.keys(clone.states)) {
      visitState(clone.states[stateKey]);
    }
  }

  // Also check root-level invoke (rare, but possible)
  if (Array.isArray(clone.invoke)) {
    for (const invokeObj of clone.invoke) {
      if (invokeObj.src) fillInvokeDefaults(invokeObj);
    }
  }

  return { fulljson: clone, childActorsInfo };
}

/**
 * Reads machine.ts from absFolderPath, runs the full FSM compilation pipeline,
 * and writes fsm.json + xstate-fsm.json into absOutputFolderPath (defaults to
 * absFolderPath itself, alongside machine.ts).
 *
 * A missing machine.ts is the one expected, non-fatal outcome — logged and
 * returned normally, since {@linkcode generateFsmJSONFromFolders} calls this
 * for every versioned subdirectory it walks and version folders without a
 * machine.ts are meant to be skipped, not treated as an error. Every other
 * failure (bad/missing export, invalid machine config, import or write
 * failure) throws instead of being logged and swallowed — see #214: a
 * swallowed error here previously let the CLI report "completed
 * successfully" with exit 0 even when nothing was actually written.
 * @param absFolderPath Absolute path to the versioned FSM directory containing machine.ts (e.g. /…/creditCheck/v01)
 * @param version Version string (e.g. "v01") used when filling in missing asyncOperationVersion on invoke actors
 * @param showRecommendation When true, validates fsm.json against the machine schema and logs issues
 * @param absOutputFolderPath Where fsm.json/xstate-fsm.json get written — independent of absFolderPath, which is only ever read from. Defaults to absFolderPath.
 */
export async function generateFsmJSONFromMachineFile(
  absFolderPath: string,
  version: string,
  showRecommendation: boolean = false,
  absOutputFolderPath: string = absFolderPath,
) {
  const machineTsPath = `${absFolderPath}/machine.ts`;

  try {
    await Deno.stat(machineTsPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      logger.info("machine.ts is missing in {path}", { path: absFolderPath });
      return;
    }
    throw err;
  }

  // deno-lint-ignore no-explicit-any
  let module: any;
  try {
    module = await import(`file://${machineTsPath}`);
  } catch (err) {
    throw new Error(`Failed to import ${machineTsPath}`, { cause: err });
  }
  const machineConfig = module.default;
  if (!machineConfig) {
    throw new Error(`No valid export found in ${machineTsPath}`);
  }
  if (
    !(typeof machineConfig.id === "string" &&
      typeof machineConfig.config === "object" &&
      typeof machineConfig.toJSON === "function")
  ) {
    throw new Error(
      `Export in ${machineTsPath} is not a valid xstate machine config`,
    );
  }

  // absOutputFolderPath can be an arbitrary, possibly-nonexistent path (e.g.
  // a fresh --output) unlike absFolderPath, which by definition already
  // exists (machine.ts was just read from it).
  await Deno.mkdir(absOutputFolderPath, { recursive: true });

  // step 1 — export raw XState JSON and write xstate-fsm.json
  const xstateFsmJSON: AnyStateNodeDefinition = machineConfig.toJSON();
  writeFileSync(
    `${absOutputFolderPath}/xstate-fsm.json`,
    JSON.stringify(xstateFsmJSON, null, 2),
  );

  // step 2 — removeNullActions (pure): strip null entries from all action arrays
  const cleanedJSON = removeNullActions(xstateFsmJSON);

  // step 3 — normalizeActionsToObjects (pure): convert plain string actions to { type: string }
  const normalizedJSON = normalizeActionsToObjects(cleanedJSON);

  // step 4 — addActionNameFromDelay (pure): set actionName from delay on xstate.raise/xstate.cancel actions
  const enrichedJSON = addActionNameFromDelay(normalizedJSON);

  // step 5 — addMissingAsyncOperationTypeToInvokeActors (pure): fill in asyncOperationType/asyncOperationVersion on invoke entries
  const { fulljson: fsmJSON } = addMissingAsyncOperationTypeToInvokeActors(
    enrichedJSON,
    version,
  );

  // step 6 — write fsm.json
  writeFileSync(
    `${absOutputFolderPath}/fsm.json`,
    JSON.stringify(fsmJSON, null, 2),
  );

  // step 7 — (optional) validate fsm.json against schema and show recommendations
  if (showRecommendation) {
    const ajv = new Ajv({ allErrors: true, strict: true, verbose: true });
    const validate = ajv.compile(machineSchema);
    const valid = validate(fsmJSON);
    if (!valid) {
      logger.warning(
        "[recommendation] fsm.json schema issues in {path}/fsm.json: {errors}",
        { path: absOutputFolderPath, errors: validate.errors },
      );
    } else {
      logger.info(
        "[recommendation] fsm.json passes schema validation in {path}",
        { path: absOutputFolderPath },
      );
    }
  }
}

async function generateFsmJSONFromFolder(
  _dirEntryName: string,
  dirEntryNameVersion: string,
  _folderPath: string,
  absFolderPath: string,
  _parentSource: string,
  showRecommendation: boolean = false,
) {
  await generateFsmJSONFromMachineFile(
    absFolderPath,
    dirEntryNameVersion,
    showRecommendation,
  );
}

/**
 * Walks every versioned FSM folder under `folderPath` and compiles each
 * machine.ts found (see {@linkcode generateFsmJSONFromMachineFile}). A single
 * FSM's failure doesn't abort the whole run — every other FSM/version still
 * gets a chance to generate — but once the walk finishes, any failures
 * collected along the way are thrown together as an {@linkcode AggregateError}
 * so the caller (the CLI) still reports overall failure instead of silently
 * exiting 0 (see #214).
 */
export async function generateFsmJSONFromFolders(
  folderPath: string,
  skipDirs: string[] = [],
  showRecommendation: boolean = false,
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
  const errors: Error[] = [];
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
              await generateFsmJSONFromFolder(
                dirEntry.name,
                subEntry.name,
                folderPath,
                `${fsmDirPath}/${subEntry.name}`,
                dirEntry.name,
                showRecommendation,
              );
            } catch (err) {
              const wrapped = err instanceof Error
                ? err
                : new Error(String(err));
              logger.error("Failed to generate fsm.json for {path}: {error}", {
                path: `${fsmDirPath}/${subEntry.name}`,
                error: wrapped,
              });
              errors.push(wrapped);
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
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `generate failed for ${errors.length} FSM version folder(s) under ${folderPath}`,
    );
  }
}
