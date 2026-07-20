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
  type WorkflowType,
} from "./util.ts";
import type { AnyStateNodeDefinition } from "xstate";
import type {
  ActionObject,
  InvokeObject,
} from "./generated/fsm-machine-schema.types.ts";

/**
 * Working shape for the compiler's internal transform pipeline — the space
 * between raw XState `.toJSON()` output and the fully-compiled FsmMachineJson
 * (see ./generated/fsm-machine-schema.types.ts, generated from
 * ../../database-src/fsm.machine.schema.v3.json). Entry/exit items may still
 * be plain strings (XState 5 action shorthand, normalized to actionObjects by
 * normalizeActionsToObjects below) or `null` placeholders left by
 * conditionally-skipped actions in machine.ts (stripped by
 * removeNullActions). By the time generateFsmJSONFromMachineFile finishes the
 * pipeline, the result should satisfy FsmMachineJson — enforced at runtime by
 * the AJV validation in the showRecommendation step.
 */
type FsmDraftAction = string | ActionObject;

type FsmDraftTransition = {
  actions?: FsmDraftAction[];
  eventType?: string;
  delay?: string | number;
  guard?: string;
  source?: string;
  target?: string[];
};

type FsmDraftInvoke = Partial<InvokeObject> & { src?: string };

export type FsmDraftStateNode = {
  id?: string;
  key?: string;
  type?: string;
  entry?: FsmDraftAction[];
  exit?: FsmDraftAction[];
  initial?: { actions?: FsmDraftAction[]; source?: string; target?: string[] };
  on?: Record<string, FsmDraftTransition[]>;
  transitions?: FsmDraftTransition[];
  invoke?: FsmDraftInvoke[];
  states?: Record<string, FsmDraftStateNode>;
};

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
 * Pure function — returns a new FSM JSON with missing fsmType/fsmVersion/fsmLanguage
 * added to every invoke entry, plus a flat list of all child actor metadata.
 * fsmLanguage defaults to "typescript" when absent.
 * Does not mutate the input.
 * @param fsmJSON The FSM JSON object
 * @param parentFsmVersion Fallback fsmVersion applied when invoke entry has none
 * @returns { fulljson, childActorsInfo }
 */
export function addMissingFsmTypeToInvokeActors(
  fsmJSON: FsmDraftStateNode,
  parentFsmVersion: string,
): {
  fulljson: FsmDraftStateNode;
  childActorsInfo: Array<
    {
      child_actor_src: string;
      child_actor_fsmType: string;
      child_actor_fsmVersion: string;
      child_actor_fsmLanguage: string;
    }
  >;
} {
  const clone: FsmDraftStateNode = JSON.parse(JSON.stringify(fsmJSON));
  const childActorsInfo: Array<
    {
      child_actor_src: string;
      child_actor_fsmType: string;
      child_actor_fsmVersion: string;
      child_actor_fsmLanguage: string;
    }
  > = [];

  function fillInvokeDefaults(invokeObj: FsmDraftInvoke) {
    if (!("fsmType" in invokeObj)) {
      invokeObj.fsmType = "promise";
    }
    if (!("fsmVersion" in invokeObj)) {
      invokeObj.fsmVersion = parentFsmVersion;
    }
    if (!("fsmLanguage" in invokeObj)) {
      invokeObj.fsmLanguage = "typescript";
    }
    if (invokeObj.src) {
      childActorsInfo.push({
        child_actor_src: invokeObj.src,
        child_actor_fsmType: invokeObj.fsmType ?? "promise",
        child_actor_fsmVersion: invokeObj.fsmVersion ?? parentFsmVersion,
        child_actor_fsmLanguage: invokeObj.fsmLanguage ?? "typescript",
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
      const xstateFsmJSON: AnyStateNodeDefinition = machineConfig.toJSON();
      writeFileSync(
        `${absFolderPath}/xstate-fsm.json`,
        JSON.stringify(xstateFsmJSON, null, 2),
      );

      // step 2 — removeNullActions (pure): strip null entries from all action arrays
      const cleanedJSON = removeNullActions(xstateFsmJSON);

      // step 3 — normalizeActionsToObjects (pure): convert plain string actions to { type: string }
      const normalizedJSON = normalizeActionsToObjects(cleanedJSON);

      // step 4 — addActionNameFromDelay (pure): set actionName from delay on xstate.raise/xstate.cancel actions
      const enrichedJSON = addActionNameFromDelay(normalizedJSON);

      // step 5 — addMissingFsmTypeToInvokeActors (pure): fill in fsmType/fsmVersion on invoke entries
      const { fulljson: fsmJSON } = addMissingFsmTypeToInvokeActors(
        enrichedJSON,
        version,
      );

      // step 6 — write fsm.json
      writeFileSync(
        `${absFolderPath}/fsm.json`,
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
            { path: absFolderPath, errors: validate.errors },
          );
        } else {
          logger.info(
            "[recommendation] fsm.json passes schema validation in {path}",
            { path: absFolderPath },
          );
        }
      }
    } else {
      logger.error("Export in {path} is not a valid xstate machine config", {
        path: machineTsPath,
      });
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      logger.info("machine.ts is missing in {path}", { path: absFolderPath });
    } else {
      logger.error("Failed to import or process {path}: {error}", {
        path: machineTsPath,
        error: err,
      });
    }
  }
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
  await generateFsmJSONFromMachineFile(
    absFolderPath,
    dirEntryNameVersion,
    workflowType,
    showRecommendation,
  );
}

export async function generateFsmJSONFromFolders(
  folderPath: string,
  workflowType: WorkflowType,
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
  for await (const dirEntry of Deno.readDir(absFolderPath)) {
    if (dirEntry.isDirectory) {
      if (skipDirs.includes(dirEntry.name)) {
        continue;
      }

      const fsmDirPath = `${absFolderPath}/${dirEntry.name}`;

      for await (const subEntry of Deno.readDir(fsmDirPath)) {
        if (subEntry.isDirectory) {
          if (isVersionFolderName(subEntry.name)) {
            await generateFsmJSONFromFolder(
              dirEntry.name,
              subEntry.name,
              folderPath,
              `${fsmDirPath}/${subEntry.name}`,
              dirEntry.name,
              workflowType,
              showRecommendation,
            );
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
}
