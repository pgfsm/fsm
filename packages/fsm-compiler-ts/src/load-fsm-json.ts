import { getLogger } from "@logtape/logtape";

const logger = getLogger(["@pgfsm/compiler", "load"]);
import { isVersionFolderName } from "./util.ts";
import {
  type DBDeps,
  type FsmDefinition,
  type LoadFsmDefinitionResult,
  loadFsmDefinitions,
} from "@pgfsm/db";
import type { Json } from "@pgfsm/db/database.types";

/**
 * Loads every `<folderPath>/<fsmName>/<version>/fsm.json` into the database,
 * as one batch through `@pgfsm/db`'s `loadFsmDefinitions`: validated first,
 * child FSMs before the parents that invoke them, all in one transaction, and
 * throwing (nothing loaded) on any failure.
 *
 * @deprecated Loading moved to `pgfsmctl fsm load <folder>` (@pgfsm/ctl,
 * SPEC-006); this and the CLI's `-c load` go away in a later release.
 * @param folderPath Absolute or relative path to the folder containing FSM JSON files
 */
export async function loadFsmJSONFromFolders(
  folderPath: string,
  skipDirs: string[] = [],
  deps: DBDeps,
): Promise<LoadFsmDefinitionResult[]> {
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
  const absFolderPath = folderPath.startsWith("/")
    ? folderPath
    : `${Deno.cwd()}/${folderPath}`;
  logger.info("Importing workflows from {path}", { path: absFolderPath });

  const definitions: FsmDefinition[] = [];
  for await (const dirEntry of Deno.readDir(absFolderPath)) {
    if (!dirEntry.isDirectory || skipDirs.includes(dirEntry.name)) continue;
    const fsmDirPath = `${absFolderPath}/${dirEntry.name}`;
    for await (const subEntry of Deno.readDir(fsmDirPath)) {
      if (!subEntry.isDirectory) continue;
      if (!isVersionFolderName(subEntry.name)) {
        logger.info("Skipping non-versioned folder: {name} in {dir}", {
          name: subEntry.name,
          dir: fsmDirPath,
        });
        continue;
      }
      const fsmJsonPath = `${fsmDirPath}/${subEntry.name}/fsm.json`;
      let text: string;
      try {
        text = await Deno.readTextFile(fsmJsonPath);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          logger.info("fsm.json is missing in {path}", {
            path: `${fsmDirPath}/${subEntry.name}`,
          });
          continue;
        }
        throw err;
      }
      definitions.push({
        fsmName: dirEntry.name,
        fsmVersion: subEntry.name,
        fsmJson: JSON.parse(text) as Json,
      });
    }
  }

  const results = await loadFsmDefinitions(deps, definitions);
  for (const r of results) {
    logger.info("{fsm}: {status}", {
      fsm: `${r.fsmName}/${r.fsmVersion}`,
      status: r.status,
    });
  }
  return results;
}
