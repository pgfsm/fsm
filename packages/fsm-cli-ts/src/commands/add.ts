import { join, relative, SEPARATOR } from "@std/path";
import {
  FSM_DIR_NAME,
  generateAll,
  isNotFoundError,
  isVersionFolderName,
} from "@pgfsm/compiler";
import { type ProjectConfig, upsertFsm } from "../project.ts";
import type { WriteReport } from "../report.ts";
import type { ResolvedSource } from "../source.ts";

export class FsmExistsError extends Error {}

/**
 * A machine.ts is compiled where it lives (never copied, #376), so its bare
 * imports must resolve: under Deno through the working directory's config
 * (the project's deno.json maps xstate), under the npm/npx build through the
 * nearest deno.json to the file (@pgfsm/compiler's #270 hook). This turns
 * the runtime's module-not-found into that advice instead of a stack trace.
 */
export class MachineImportError extends Error {
  constructor(path: string, specifier: string) {
    super(
      `${path} imports "${specifier}", which couldn't be resolved. Run pgfsm from your project root (its deno.json maps xstate), or add a deno.json next to the machine.ts with {"imports": {"${specifier}": "npm:${specifier}"}}.`,
    );
  }
}

/** The bare specifier a machine.ts import failed on, if that's what went wrong. */
function unresolvedImport(err: unknown): string | undefined {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const m = e.message.match(
      /Import "([^"]+)" not a dependency|Cannot find (?:package|module) '([^']+)'/,
    );
    if (m) return m[1] ?? m[2];
  }
  return undefined;
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

/** The first `vNN` after every version already under `fsm/<name>/`. */
async function nextFreeVersion(root: string, name: string): Promise<string> {
  let max = 0;
  try {
    for await (const e of Deno.readDir(join(root, FSM_DIR_NAME, name))) {
      if (e.isDirectory && isVersionFolderName(e.name)) {
        max = Math.max(max, Number(e.name.slice(1)));
      }
    }
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
  return `v${String(max + 1).padStart(2, "0")}`;
}

/** Project-relative, POSIX-separated -- pgfsm.config.json is shared across OSes. */
function toConfigPath(root: string, path: string): string {
  return relative(root, path).split(SEPARATOR).join("/");
}

/**
 * Compiles/copies one FSM version into `fsm/<name>/<version>/` and scaffolds
 * its stubs in the worker projects, via the compiler's single-file
 * `generateAll` in `generated-only` mode -- existing stubs and entry files
 * are never overwritten. FSM versions are treated as immutable: an existing
 * `fsm/<name>/<version>/` is refused unless `force`.
 */
export async function addFsm(
  root: string,
  config: ProjectConfig,
  source: ResolvedSource,
  opts: { force?: boolean; report: WriteReport; sourceRoot?: string },
): Promise<void> {
  const target = join(root, FSM_DIR_NAME, source.name, source.version);
  const inPlace = source.path === join(target, source.kind);
  if (!opts.force && !inPlace && await exists(join(target, "fsm.json"))) {
    const next = await nextFreeVersion(root, source.name);
    throw new FsmExistsError(
      `${FSM_DIR_NAME}/${source.name}/${source.version} already exists. FSM versions are immutable: add it as --fsm-version ${next}, or pass --force to replace it.`,
    );
  }

  try {
    await generateAll({
      folder: source.path,
      writeRootAbsPath: root,
      fsmName: source.name,
      fsmVersion: source.version,
      force: opts.force,
      overwrite: "generated-only",
      onFileWrite: opts.report.onFileWrite,
    });
  } catch (err) {
    const unresolved = source.kind === "machine.ts" && unresolvedImport(err);
    if (unresolved) throw new MachineImportError(source.path, unresolved);
    throw err;
  }

  upsertFsm(config, {
    name: source.name,
    version: source.version,
    // In a dry-run sandbox, still record the path relative to the real root.
    source: toConfigPath(opts.sourceRoot ?? root, source.path),
  });
}
