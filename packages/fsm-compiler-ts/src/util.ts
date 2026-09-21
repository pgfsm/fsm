import type { Json } from "@pgfsm/db/database.types";
import type {
  ActionObject,
  ActorReference,
  AtomicStateNode,
  CompoundStateNode,
  FinalStateNode,
  FsmMachineJson,
  HistoryStateNode,
  ParallelStateNode,
} from "./types/index.ts";

/**
 * Structural stand-in for `Deno.Command`'s constructor, covering only the
 * options/output shape actually used in this codebase (`args`/`cwd`/
 * `stdout`/`stderr` in, `success`/`stderr` out). Deliberately NOT derived
 * from `typeof Deno.Command` — that type reference itself fails to
 * typecheck once this file is built for npm via `deno task build:npm` (dnt
 * + `@deno/shim-deno`), because the shim doesn't implement `Command` at all
 * (see its own PROGRESS.md:
 * https://github.com/denoland/node_shims/blob/main/packages/shim-deno/PROGRESS.md,
 * where it's listed unchecked).
 */
type DenoCommandCtor = new (command: string, options?: {
  args?: string[];
  cwd?: string;
  stdout?: "piped" | "null" | "inherit";
  stderr?: "piped" | "null" | "inherit";
}) => {
  output(): Promise<
    { success: boolean; stdout: Uint8Array; stderr: Uint8Array }
  >;
};

/**
 * `Deno.Command`'s constructor, or `undefined` when running under the
 * npm/npx build (no subprocess support there — see {@linkcode DenoCommandCtor}).
 * Every caller must check for that before constructing.
 */
export const DenoCommand: DenoCommandCtor | undefined =
  (Deno as unknown as { Command?: DenoCommandCtor }).Command;

export const DELAY_ACTION_NAME_PREFIX = "delay";

export const RAISE_CANCEL: Set<string> = new Set([
  "xstate.raise",
  "xstate.cancel",
]);

/**
 * Capitalizes a name's first letter. Go enforces exports at compile time for
 * cross-package access (unlike TS/Python/Rust's dynamic-import or
 * same-crate-`pub` access) — a Go actor function invoked from a separate
 * consuming package must be exported, so its generated name is capitalized
 * (see #83). `src` itself (the actor's identity/invoke id) is left untouched.
 */
export function toGoExportedName(name: string): string {
  return name.length === 0 ? name : name[0].toUpperCase() + name.slice(1);
}

type FsmStateOrMachine =
  | FsmMachineJson
  | AtomicStateNode
  | CompoundStateNode
  | ParallelStateNode
  | HistoryStateNode
  | FinalStateNode;

/**
 * Recursively traverses FSM JSON and collects all action, guard, delay, and actor names.
 * Actors are returned as objects preserving asyncOperationType, asyncOperationVersion, and asyncOperationLanguage
 * (asyncOperationLanguage defaults to "typescript" when absent on the invoke object).
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
          asyncOperationType: inv.asyncOperationType,
          asyncOperationVersion: inv.asyncOperationVersion,
          asyncOperationLanguage: inv.asyncOperationLanguage ?? "typescript",
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
 * True when `error` represents a "path does not exist" failure from a Deno
 * filesystem call, under BOTH the real Deno runtime and the npm/npx build.
 *
 * Real Deno throws a genuine `Deno.errors.NotFound` for a missing path, so
 * `instanceof` alone is enough there. Under the npm/npx build, `Deno.remove`/
 * `Deno.removeSync` are `@deno/shim-deno`'s implementations — and unlike its
 * `stat`/`lstat`/`readTextFile`/`readDir` (which correctly map Node's raw
 * `fs` errors into real `Deno.errors.*` instances via an internal
 * `errorMap`), `remove`/`removeSync` do not: a missing path (without
 * `{ recursive: true }`, which Node maps to `{ recursive: true, force: true
 * }` and so never throws at all) rethrows the raw Node `fs.rm`/`fs.rmSync`
 * error unwrapped — a plain `Error` with `.code === "ENOENT"`, never an
 * instance of `Deno.errors.NotFound`. An `instanceof`-only check therefore
 * silently breaks "ignore missing path" cleanup logic built on non-recursive
 * `Deno.remove`/`Deno.removeSync` once built for npm/npx — see #278.
 */
export function isNotFoundError(error: unknown): boolean {
  if (error instanceof Deno.errors.NotFound) return true;
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

/**
 * Checks whether `name` is a syntactically valid, non-keyword Python
 * identifier. Needed wherever generated Python code imports a module via a
 * dotted path built from an on-disk folder name (e.g. the worker-sdk
 * aggregate registry's `fsm.<fsmName>.<fsmVersion>...` import) — unlike TS's
 * string import specifiers or Rust's `#[path]`, Python's `import a.b.c`
 * syntax requires every path segment to already be a valid identifier on
 * disk, so an arbitrary folder name can't just be sanitized/escaped the way
 * filename-sanitizing helpers do elsewhere in this package — it either
 * already matches, or the import can't be made static.
 */
export function isValidPythonIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !PYTHON_KEYWORDS.has(name);
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
