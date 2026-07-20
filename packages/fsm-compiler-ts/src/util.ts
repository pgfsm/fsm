import type { Json } from "@pgfsm/db/database.types";
import type {
  ActionObject,
  AtomicStateNode,
  CompoundStateNode,
  FinalStateNode,
  FsmMachineJson,
  HistoryStateNode,
  ParallelStateNode,
} from "./generated/fsm-machine-schema.types.ts";

export type WorkflowType = "fsm" | "sharedFsm" | "sharedPromise" | "promise";

export type ActorReference = {
  src: string;
  fsmType?: string;
  fsmVersion?: string;
  fsmLanguage?: string;
};
export type FailedMethod = {
  method: string;
  moduleType: string;
  modulePath: string;
};

export type FsmPluginValidationResult = {
  src: string;
  fsmName: string;
  fsmVersion: string;
  fsmType: WorkflowType;
  fsmAbsFolderPath: string;
  fsmRelativeFolderPath: string;
  fsmParentDirName: string;
  fsmParentAbsFolderPath: string;
  fsmParentRelativeFolderPath: string;
  fsmJsonConfigData: FsmMachineJson | undefined;
  fsmJsonPresent: boolean;
  fsmJsonFollowSchema: boolean;
  isFsmModuleVerified: boolean;
  fsmModuleDefinition: Json;
  failedMethods: FailedMethod[];
  asyncOperationActors: ActorReference[];
  isAsyncOperationActorsVerified?: boolean;
};

export type ActorPluginValidationResult = {
  src: string;
  method: string;
  fsmName: string;
  fsmType: "promise";
  fsmVersion: string;
  fsmLanguage: string;
  isVerified: boolean;
  fsmModulePath: string;
  parentFsmName: string;
  parentFsmVersion: string;
  comment: string;
  parentFsmPath: string;
  errorMessage: string | null;
};

export const DELAY_ACTION_NAME_PREFIX = "delay";

export const RAISE_CANCEL: Set<string> = new Set([
  "xstate.raise",
  "xstate.cancel",
]);

type FsmStateOrMachine =
  | FsmMachineJson
  | AtomicStateNode
  | CompoundStateNode
  | ParallelStateNode
  | HistoryStateNode
  | FinalStateNode;

/**
 * Recursively traverses FSM JSON and collects all action, guard, delay, and actor names.
 * Actors are returned as objects preserving fsmType, fsmVersion, and fsmLanguage
 * (fsmLanguage defaults to "typescript" when absent on the invoke object).
 */
export function extractFsmPluginRefs(fsmData: FsmMachineJson): {
  actions: string[];
  guards: string[];
  delays: string[];
  actors: ActorReference[];
} {
  const actionsSet = new Set<string>();
  const guardsSet = new Set<string>();
  const delaysSet = new Set<string>();
  const actorsArr: ActorReference[] = [];

  // Not every fsm.json on disk has necessarily been regenerated with the
  // current compiler (which always emits actionObjects); tolerate the older
  // plain-string action shorthand defensively.
  function collectActionName(a: ActionObject) {
    const value: unknown = a;
    if (typeof value === "string") actionsSet.add(value);
    else if (a && typeof a.type === "string") actionsSet.add(a.type);
  }

  function visitState(state: FsmStateOrMachine) {
    if ("entry" in state && Array.isArray(state.entry)) {
      state.entry.forEach(collectActionName);
    }
    if ("exit" in state && Array.isArray(state.exit)) {
      state.exit.forEach(collectActionName);
    }

    if ("on" in state && state.on) {
      for (const eventKey of Object.keys(state.on)) {
        const transitions = state.on[eventKey];
        for (const transition of transitions) {
          transition.actions.forEach(collectActionName);
          if (transition.guard) guardsSet.add(transition.guard);
          if (transition.delay !== undefined) {
            delaysSet.add(String(transition.delay));
          }
        }
      }
    }

    if ("transitions" in state && state.transitions) {
      for (const transition of state.transitions) {
        transition.actions.forEach(collectActionName);
        if (transition.guard) guardsSet.add(transition.guard);
        if (transition.delay !== undefined) {
          delaysSet.add(String(transition.delay));
        }
      }
    }

    if ("invoke" in state && state.invoke) {
      for (const inv of state.invoke) {
        actorsArr.push({
          src: inv.src,
          fsmType: inv.fsmType,
          fsmVersion: inv.fsmVersion,
          fsmLanguage: inv.fsmLanguage ?? "typescript",
        });
      }
    }

    if ("states" in state && state.states) {
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

/**
 * Checks if a string matches the date pattern YYYY-MM-DD-HH-MM.
 * @param name The string to test
 * @returns true if matches, false otherwise
 */
export function isValidDateFolderName(name: string): boolean {
  // Use Date parsing to validate YYYY-MM-DD-HH-MM
  const parts = name.split("-");
  if (parts.length !== 5) return false;
  const [year, month, day, hour, minute] = parts.map(Number);
  if (
    isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hour) || isNaN(minute) ||
    year < 1000 || year > 9999 ||
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour < 0 || hour > 23 ||
    minute < 0 || minute > 59
  ) {
    return false;
  }
  // Construct a Date object and check if it matches
  const date = new Date(year, month - 1, day, hour, minute);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute
  );
}
/**
 * Checks if a string matches the version pattern v01, v02, etc.
 * @param name The string to test
 * @returns true if matches, false otherwise
 */
export function isVersionFolderName(name: string): boolean {
  return /^v\d{2}$/.test(name);
}
/**
 * Checks if a string matches the timestamp pattern YYYYMMDDHHMMSS (14 digits).
 * @param name The string to test
 * @returns true if matches, false otherwise
 */
export function isTimestampFolderName(name: string): boolean {
  return /^\d{14}$/.test(name);
}

/**
 * Recursively replaces underscores with spaces in keys and string values of an object.
 */
export function replaceUnderscoresWithSpaces(objWithMachine: Json): Json {
  const obj = objWithMachine?.machine ? objWithMachine.machine : objWithMachine;
  if (Array.isArray(obj)) {
    return obj.map(replaceUnderscoresWithSpaces);
  } else if (obj && typeof obj === "object") {
    return Object.entries(obj).reduce((acc, [key, value]) => {
      const newKey = typeof key === "string" ? key.replace(/_/g, " ") : key;
      acc[newKey] = replaceUnderscoresWithSpaces(value);
      return acc;
    }, {} as Json);
  } else if (typeof obj === "string") {
    return obj.replace(/_/g, " ");
  } else {
    return obj;
  }
}

/**
 * Recursively replaces spaces with underscores in keys and string values of an object.
 */
export function replaceSpacesWithUnderscores(obj: Json): Json {
  if (Array.isArray(obj)) {
    return obj.map(replaceSpacesWithUnderscores);
  } else if (obj && typeof obj === "object") {
    return Object.entries(obj).reduce((acc, [key, value]) => {
      const newKey = typeof key === "string" ? key.replace(/ /g, "_") : key;
      acc[newKey] = replaceSpacesWithUnderscores(value);
      return acc;
    }, {} as Json);
  } else if (typeof obj === "string") {
    return obj.replace(/ /g, "_");
  } else {
    return obj;
  }
}
