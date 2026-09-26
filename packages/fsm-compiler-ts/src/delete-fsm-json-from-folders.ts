import { getLogger } from "@logtape/logtape";

const logger = getLogger(["@pgfsm/compiler", "delete"]);
import { isNotFoundError, isVersionFolderName } from "./util.ts";
import { SUPPORTED_OPERATION_LANGS } from "./operation-logic-scaffold.ts";

export interface DeleteFsmJsonOptions {
  /**
   * Also remove each FSM version's `{cwd}/sync-worker/typescript/<fsmName>/<fsmVersion>/`
   * and `{cwd}/async-worker/<lang>/<fsmName>/<fsmVersion>/` folders. Off by
   * default (#377): those hold the action/guard/delay and actor stubs the
   * developer implements, which nothing can regenerate.
   */
  includeWorkers?: boolean;
}

/**
 * `{cwd}`-anchored worker folders generate-sync-logic/generate-async-logic
 * write for one FSM version (see generate-sync-operation-logic.ts /
 * generate-async-operation-logic.ts) -- independent of the version folder
 * itself. One per async language, since a given FSM/version might only have
 * used some of them.
 */
function workerDirsFor(fsmName: string, fsmVersion: string): string[] {
  return [
    `${Deno.cwd()}/sync-worker/typescript/${fsmName}/${fsmVersion}`,
    ...SUPPORTED_OPERATION_LANGS.map((lang) =>
      `${Deno.cwd()}/async-worker/${lang}/${fsmName}/${fsmVersion}`
    ),
  ];
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
 * Best-effort recursive remove: silently does nothing if `path` doesn't
 * exist (unlike a bare `Deno.remove(path, { recursive: true })`, which still
 * throws `NotFound` for a missing top-level path -- `recursive` only avoids
 * "directory not empty," not "path doesn't exist"). Used for the
 * `--include-workers` cleanup below, where several independent paths (one
 * per language) may or may not exist for a given FSM/version, and one
 * missing path must not abort the rest.
 */
async function removeIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }
}

async function deleteFsmJSONFromFolder(
  dirEntryName: string,
  dirEntryNameVersion: string,
  _folderPath: string,
  absFolderPath: string,
  _parentSource: string,
  includeWorkers: boolean,
) {
  // A version folder with no machine.ts holds an fsm.json that can't be
  // regenerated from here -- e.g. one written by generate-fsm-json's
  // single-file mode into {cwd}/fsm/ from a machine.ts that lives elsewhere
  // (#376), or a hand-authored fsm.json. Deleting it would lose the only
  // copy, so keep it (and its worker folders) untouched.
  try {
    await Deno.stat(`${absFolderPath}/machine.ts`);
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    logger.info(
      "No machine.ts in {path}: keeping fsm.json, since it can't be regenerated from here",
      { path: absFolderPath },
    );
    return;
  }

  try {
    await Deno.remove(`${absFolderPath}/xstate-fsm.json`);
    await Deno.remove(`${absFolderPath}/fsm.json`);

    const workerDirs = workerDirsFor(dirEntryName, dirEntryNameVersion);
    if (includeWorkers) {
      for (const dir of workerDirs) await removeIfExists(dir);
    } else {
      // Before #377 these were removed unconditionally, silently deleting
      // the developer's implemented stubs. Keep them, and say so.
      const kept: string[] = [];
      for (const dir of workerDirs) {
        if (await exists(dir)) kept.push(dir);
      }
      if (kept.length > 0) {
        logger.info(
          "Kept worker folders for {fsm} (they may contain your code; pass --include-workers to remove them): {kept}",
          { fsm: `${dirEntryName}/${dirEntryNameVersion}`, kept },
        );
      }
    }

    logger.info("Deleted xstate-fsm.json and fsm.json from {path}", {
      path: absFolderPath,
    });
  } catch (err) {
    if (isNotFoundError(err)) {
      logger.info(
        "fsm.json or xstate-fsm.json is missing in {path}, nothing to delete",
        { path: `${absFolderPath}/${dirEntryName}` },
      );
    } else {
      logger.error("Failed to delete {path}/fsm.json: {error}", {
        path: absFolderPath,
        error: err,
      });
    }
  }
}

/**
 * Walks every versioned FSM folder under `folderPath` and deletes its
 * generated fsm.json + xstate-fsm.json (skipping folders with no machine.ts,
 * whose fsm.json can't be regenerated). Worker folders are only removed with
 * `options.includeWorkers` (#377).
 */
export async function deleteFsmJSONFromFolders(
  folderPath: string,
  skipDirs: string[] = [],
  options: DeleteFsmJsonOptions = {},
) {
  const includeWorkers = options.includeWorkers ?? false;
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
            await deleteFsmJSONFromFolder(
              dirEntry.name,
              subEntry.name,
              folderPath,
              `${fsmDirPath}/${subEntry.name}`,
              dirEntry.name,
              includeWorkers,
            );
          } else {
            logger.info("Skipping non-timestamped folder: {name} in {dir}", {
              name: subEntry.name,
              dir: fsmDirPath,
            });
          }
        }
      }
    }
  }
}
