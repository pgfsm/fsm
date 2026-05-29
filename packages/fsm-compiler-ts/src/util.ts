export type WorkflowType = "fsm" | "sharedFsm" | "sharedPromise" | "promise";

export type ActorReference = { src: string; fsmType?: string; fsmVersion?: string };
export type FailedMethod = { method: string; moduleType: string; modulePath: string };

export type InternalActor = {
  src: string;
  fsmName: string;
  fsmType?: string;
  fsmVersion?: string;
  fsmAbsFolderPath: string;
  fsmRelativeFolderPath: string;
};

export type ExternalActor = {
  src: string;
  fsmType?: string;
  fsmVersion?: string;
  resolved: boolean;
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
  fsmJsonPresent: boolean;
  fsmJsonFollowSchema: boolean;
  isFsmModuleVerified: boolean;
  fsmModuleDefinition: any;
  failedMethods: FailedMethod[];
  internalActors: InternalActor[];
  externalActors: ExternalActor[];
};

export const DELAY_ACTION_NAME_PREFIX = "delay";

export const RAISE_CANCEL = new Set(["xstate.raise", "xstate.cancel"]);

/**
 * Recursively traverses FSM JSON and collects all action, guard, delay, and actor names.
 * Actors are returned as objects preserving fsmType and fsmVersion.
 */
export function extractFsmPluginRefs(fsmData: any): {
  actions: string[];
  guards: string[];
  delays: string[];
  actors: { src: string; fsmType?: string; fsmVersion?: string }[];
} {
  const actionsSet = new Set<string>();
  const guardsSet = new Set<string>();
  const delaysSet = new Set<string>();
  const actorsArr: { src: string; fsmType?: string; fsmVersion?: string }[] = [];

  function collectActionName(a: any) {
    if (typeof a === "string") actionsSet.add(a);
    else if (a && typeof a === "object" && typeof a.type === "string") actionsSet.add(a.type);
  }

  function visitState(state: any) {
    if (Array.isArray(state.entry)) state.entry.forEach(collectActionName);
    if (Array.isArray(state.exit)) state.exit.forEach(collectActionName);

    if (state.on && typeof state.on === "object") {
      for (const eventKey of Object.keys(state.on)) {
        const transitions = state.on[eventKey];
        if (Array.isArray(transitions)) {
          for (const transition of transitions) {
            if (Array.isArray(transition.actions)) transition.actions.forEach(collectActionName);
            if (transition.guard && typeof transition.guard === "string") guardsSet.add(transition.guard);
            if (transition.delay) delaysSet.add(transition.delay);
          }
        }
      }
    }

    if (Array.isArray(state.transitions)) {
      for (const transition of state.transitions) {
        if (Array.isArray(transition.actions)) transition.actions.forEach(collectActionName);
        if (transition.guard && typeof transition.guard === "string") guardsSet.add(transition.guard);
        if (transition.delay) delaysSet.add(transition.delay);
      }
    }

    if (Array.isArray(state.invoke)) {
      for (const inv of state.invoke) {
        if (inv && typeof inv.src === "string") {
          actorsArr.push({ src: inv.src, fsmType: inv.fsmType, fsmVersion: inv.fsmVersion });
        }
      }
    }

    if (state.states && typeof state.states === "object") {
      for (const subKey of Object.keys(state.states)) visitState(state.states[subKey]);
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
		isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hour) || isNaN(minute)
		|| year < 1000 || year > 9999
		|| month < 1 || month > 12
		|| day < 1 || day > 31
		|| hour < 0 || hour > 23
		|| minute < 0 || minute > 59
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
export function replaceUnderscoresWithSpaces(objWithMachine: any): any {
  const obj = objWithMachine?.machine ? objWithMachine.machine : objWithMachine;
  if (Array.isArray(obj)) {
    return obj.map(replaceUnderscoresWithSpaces);
  } else if (obj && typeof obj === "object") {
    return Object.entries(obj).reduce((acc, [key, value]) => {
      const newKey = typeof key === "string" ? key.replace(/_/g, " ") : key;
      acc[newKey] = replaceUnderscoresWithSpaces(value);
      return acc;
    }, {} as any);
  } else if (typeof obj === "string") {
    return obj.replace(/_/g, " ");
  } else {
    return obj;
  }
}

/**
 * Recursively replaces spaces with underscores in keys and string values of an object.
 */
export function replaceSpacesWithUnderscores(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(replaceSpacesWithUnderscores);
  } else if (obj && typeof obj === "object") {
    return Object.entries(obj).reduce((acc, [key, value]) => {
      const newKey = typeof key === "string" ? key.replace(/ /g, "_") : key;
      acc[newKey] = replaceSpacesWithUnderscores(value);
      return acc;
    }, {} as any);
  } else if (typeof obj === "string") {
    return obj.replace(/ /g, "_");
  } else {
    return obj;
  }
}
