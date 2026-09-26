import { dirname, join, resolve } from "@std/path";
import { isNotFoundError, SUPPORTED_OPERATION_LANGS } from "@pgfsm/compiler";
import type { OperationLang } from "@pgfsm/compiler";

/** The project marker (SPEC-004). Its presence is what makes a directory a pgfsm project. */
export const CONFIG_FILE_NAME = "pgfsm.config.json";

/** One FSM version the project tracks, and where it was added from. */
export interface FsmEntry {
  name: string;
  version: string;
  /**
   * The machine.ts or fsm.json it was added from, relative to the project
   * root (POSIX separators). `sync` recompiles from here: the compiler never
   * copies a machine.ts into fsm/ (#376), so this is the only record of it.
   */
  source: string;
}

export interface ProjectConfig {
  $schema?: string;
  /** Project name; also sync-worker/typescript/deno.json's `name`. */
  name: string;
  /** @pgfsm/cli version that created the project, for the drift warning. */
  toolVersion: string;
  fsmDir: string;
  asyncWorkerLangs: OperationLang[];
  syncWorkerLangs: OperationLang[];
  fsms: FsmEntry[];
}

export function defaultConfig(
  name: string,
  toolVersion: string,
): ProjectConfig {
  return {
    name,
    toolVersion,
    fsmDir: "fsm",
    asyncWorkerLangs: [...SUPPORTED_OPERATION_LANGS],
    syncWorkerLangs: ["typescript"],
    fsms: [],
  };
}

export interface Project {
  root: string;
  config: ProjectConfig;
}

export class NoProjectError extends Error {
  constructor(from: string) {
    super(
      `No pgfsm project found at or above ${from}. Run \`npx @pgfsm/cli create <dir>\` first.`,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

/**
 * Walks up from `from` to the nearest directory holding
 * {@linkcode CONFIG_FILE_NAME}, the way git finds `.git`. Returns `undefined`
 * when there is none.
 */
export async function findProjectRoot(
  from: string,
): Promise<string | undefined> {
  let dir = resolve(from);
  while (true) {
    if (await exists(join(dir, CONFIG_FILE_NAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function readConfig(root: string): Promise<ProjectConfig> {
  const path = join(root, CONFIG_FILE_NAME);
  let parsed: Partial<ProjectConfig>;
  try {
    parsed = JSON.parse(await Deno.readTextFile(path));
  } catch (err) {
    throw new Error(`Couldn't read ${path}`, { cause: err });
  }
  if (typeof parsed.name !== "string" || !parsed.name) {
    throw new Error(`${path} has no "name"`);
  }
  return {
    ...defaultConfig(parsed.name, parsed.toolVersion ?? "0.0.0"),
    ...parsed,
    fsms: parsed.fsms ?? [],
  } as ProjectConfig;
}

export async function writeConfig(
  root: string,
  config: ProjectConfig,
): Promise<void> {
  await Deno.writeTextFile(
    join(root, CONFIG_FILE_NAME),
    JSON.stringify(config, null, 2) + "\n",
  );
}

/** Finds and loads the project containing `from`, or throws {@linkcode NoProjectError}. */
export async function loadProject(from: string): Promise<Project> {
  const root = await findProjectRoot(from);
  if (!root) throw new NoProjectError(resolve(from));
  return { root, config: await readConfig(root) };
}

/** Adds or replaces the entry for `entry.name`/`entry.version`. */
export function upsertFsm(config: ProjectConfig, entry: FsmEntry): void {
  const i = config.fsms.findIndex((f) =>
    f.name === entry.name && f.version === entry.version
  );
  if (i >= 0) config.fsms[i] = entry;
  else config.fsms.push(entry);
  config.fsms.sort((a, b) =>
    a.name === b.name
      ? a.version.localeCompare(b.version)
      : a.name.localeCompare(b.name)
  );
}
