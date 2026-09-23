import { getLogger } from "@logtape/logtape";

const logger = getLogger(["@pgfsm/compiler", "delete"]);
import { isNotFoundError, isVersionFolderName } from "./util.ts";
import { SUPPORTED_OPERATION_LANGS } from "./operation-logic-scaffold.ts";

/**
 * Best-effort recursive remove: silently does nothing if `path` doesn't
 * exist (unlike a bare `Deno.remove(path, { recursive: true })`, which still
 * throws `NotFound` for a missing top-level path -- `recursive` only avoids
 * "directory not empty," not "path doesn't exist"). Used for the
 * `sync-worker/`/`async-worker/` cleanup below, where several independent
 * paths (one per language) may or may not exist for a given FSM/version, and
 * one missing path must not abort the rest.
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
) {
  try {
    await Deno.remove(`${absFolderPath}/xstate-fsm.json`);
    await Deno.remove(`${absFolderPath}/fsm.json`);

    // generate-sync-logic's reserved sync-worker/ output -- always written
    // to {cwd}/sync-worker/typescript/<fsmName>/<fsmVersion>/, independent
    // of absFolderPath (see generate-sync-operation-logic.ts).
    await removeIfExists(
      `${Deno.cwd()}/sync-worker/typescript/${dirEntryName}/${dirEntryNameVersion}`,
    );
    // generate-async-logic's reserved async-worker/ output -- always
    // written to {cwd}/async-worker/<lang>/<fsmName>/<fsmVersion>/,
    // independent of absFolderPath (see
    // generate-async-operation-logic.ts). One remove per language, since a
    // given FSM/version might only have used some of them.
    for (const lang of SUPPORTED_OPERATION_LANGS) {
      await removeIfExists(
        `${Deno.cwd()}/async-worker/${lang}/${dirEntryName}/${dirEntryNameVersion}`,
      );
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

export async function deleteFsmJSONFromFolders(
  folderPath: string,
  skipDirs: string[] = [],
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
            await deleteFsmJSONFromFolder(
              dirEntry.name,
              subEntry.name,
              folderPath,
              `${fsmDirPath}/${subEntry.name}`,
              dirEntry.name,
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
