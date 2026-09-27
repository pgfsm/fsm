import { dirname, join, resolve } from "@std/path";
import { isNotFoundError } from "@pgfsm/compiler";

/**
 * The project marker (SPEC-004). Its presence is what makes a directory a
 * pgfsm project: `add` walks up to it, `create` refuses to run where one
 * exists.
 */
export const CONFIG_FILE_NAME = "pgfsm.config.json";

/**
 * Deliberately minimal: nothing records where each FSM came from, since only
 * `sync` would read that and it's deferred to #390.
 */
export interface ProjectConfig {
  /** Project name; also sync-worker/typescript/deno.json's `name`. */
  name: string;
  /** @pgfsm/cli version that created the project, for the drift warning. */
  toolVersion: string;
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
  return { name: parsed.name, toolVersion: parsed.toolVersion ?? "0.0.0" };
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
