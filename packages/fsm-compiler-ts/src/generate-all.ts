import { getLogger } from "@logtape/logtape";
import {
  copyFsmJsonIntoFsmDir,
  generateFsmJSONFromFolders,
  generateFsmJSONIntoFsmDir,
} from "./generate-fsm-json.ts";
import {
  generateAsyncOperationLogicFromFolders,
  generateAsyncOperationLogicFromFsmJson,
} from "./generate-async-operation-logic.ts";
import {
  generateSyncOperationLogicFromFolders,
  generateSyncOperationLogicFromFsmJson,
} from "./generate-sync-operation-logic.ts";
import type { OperationLang } from "./types/index.ts";

const logger = getLogger(["@pgfsm/compiler", "generate-all"]);

export interface GenerateAllOptions {
  /**
   * Path to a plugin-root folder, a single machine.ts file, or a single
   * fsm.json file. Relative paths are resolved against `Deno.cwd()`.
   */
  folder: string;
  /**
   * Absolute directory `async-worker/` and `sync-worker/` are written under,
   * in every mode. The CLI always passes `Deno.cwd()`, the same anchor
   * generate-sync-logic/generate-async-logic use (#305/#307); a library
   * caller can point it anywhere.
   */
  writeRootAbsPath: string;
  /**
   * FSM name, e.g. `creditCheck`. Required in single-file mode; ignored in
   * folder mode, which derives identity per FSM while walking the tree.
   */
  fsmName?: string;
  /**
   * FSM version folder name, e.g. `v01`. Required in single-file mode (it
   * also fills in missing `asyncOperationVersion` when compiling a
   * machine.ts); ignored in folder mode.
   */
  fsmVersion?: string;
  /** Subdirectory names to skip while walking a plugin-root folder. */
  skipDirs?: string[];
  /**
   * Validates generated fsm.json against the machine schema and logs issues.
   * Only applies to the generate-fsm-json step.
   */
  showRecommendation?: boolean;
  /** Language(s) to scaffold sync operation logic (actions/guards/delays) in. Defaults to `["typescript"]`. */
  langs?: OperationLang[];
  /**
   * Single-file mode: overwrite a `fsm/<fsmName>/<fsmVersion>/fsm.json`
   * under `writeRootAbsPath` that belongs to a different machine id.
   */
  force?: boolean;
}

/**
 * Runs generate-fsm-json, then generate-async-logic, then generate-sync-logic
 * in sequence, for a plugin-root folder, a single machine.ts file, or a
 * single fsm.json file — whichever `options.folder` points at. Backs the
 * CLI's `generate-all` command; also usable directly from an npm/npx
 * consumer.
 *
 * Every mode writes `async-worker/` and `sync-worker/` under
 * `options.writeRootAbsPath` (#372) — the CLI passes `Deno.cwd()`, matching
 * generate-sync-logic/generate-async-logic. There is no `--output`: before
 * #372, folder mode wrote one level above `folder` and single-file modes
 * wrote under `--output`, so the same command landed in different places
 * depending on what it was pointed at.
 *
 * - **Folder mode** (`folder` is a plugin-root directory): runs all three
 *   steps across the whole tree. Each step already walks every versioned FSM
 *   best-effort on its own and only throws once it's done, summarizing every
 *   failure it hit as an `AggregateError` (see #214/#211) — catching each
 *   step's own `AggregateError` here (rather than letting it propagate
 *   immediately) means one step's partial failure still lets the next step
 *   run for whichever FSMs did succeed, e.g. a bad machine.ts in one FSM
 *   shouldn't block every other FSM's actor/sync stubs from being scaffolded.
 *   Every collected step failure is re-thrown together as a single
 *   `AggregateError` once the run finishes.
 * - **Single machine.ts file mode** (`folder` is a `.ts` file): chains all
 *   three steps for just this one FSM version. `fsm.json`/`xstate-fsm.json`
 *   are written to `<writeRootAbsPath>/fsm/<fsmName>/<fsmVersion>/`, exactly
 *   like generate-fsm-json's own single-file mode (#376; machine.ts itself
 *   stays put) — a step's failure here simply aborts, since there's only one
 *   FSM and nothing left for a later step to still succeed on.
 * - **Single fsm.json file mode** (`folder` is a `.json` file): the fsm.json
 *   already exists, so generate-fsm-json is skipped; it is copied to
 *   `<writeRootAbsPath>/fsm/<fsmName>/<fsmVersion>/fsm.json` (#376) and
 *   generate-async-logic/generate-sync-logic run against that copy.
 *
 * Either way, a later folder-mode run on `<writeRootAbsPath>/fsm` rebuilds
 * the same project without pointing back at the original file.
 *
 * Both single-file modes require `fsmName` and `fsmVersion`, like
 * generate-sync-logic/generate-async-logic's own single-fsm.json mode. They
 * are never guessed from the file's parent folders: `-f a/fsm.json` would
 * otherwise silently become `<cwd's name>/a` (#372).
 */
export async function generateAll(options: GenerateAllOptions): Promise<void> {
  const {
    folder,
    writeRootAbsPath,
    skipDirs = [],
    showRecommendation = false,
    langs = ["typescript"],
  } = options;

  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(folder);
  } catch {
    throw new Error(`--folder does not exist: ${folder}`);
  }

  const folderIsFsmJsonFile = stat.isFile && folder.endsWith(".json");
  const folderIsMachineTsFile = stat.isFile && folder.endsWith(".ts");

  if (stat.isFile && !folderIsFsmJsonFile && !folderIsMachineTsFile) {
    throw new Error(
      `--folder file must be a .ts or fsm.json file for generate-all: ${folder}`,
    );
  }

  if (folderIsFsmJsonFile || folderIsMachineTsFile) {
    const { fsmName, fsmVersion } = options;
    if (!fsmName || !fsmVersion) {
      throw new Error(
        `generate-all requires --fsm-name and --fsm-version when --folder is a single ${
          folderIsFsmJsonFile ? "fsm.json" : "machine.ts"
        } file`,
      );
    }
    const absPath = folder.startsWith("/") ? folder : `${Deno.cwd()}/${folder}`;

    let fsmJsonPath: string;
    if (folderIsMachineTsFile) {
      const targetDir = await generateFsmJSONIntoFsmDir({
        machineTsPath: absPath,
        fsmName,
        fsmVersion,
        writeRootAbsPath,
        showRecommendation,
        force: options.force,
      });
      fsmJsonPath = `${targetDir}/fsm.json`;
    } else {
      // fsm.json already exists (folder points straight at it) — skip
      // compiling entirely, just copy it into the fsm/ tree.
      logger.info(
        "--folder is an fsm.json file: skipping generate-fsm-json",
      );
      fsmJsonPath = await copyFsmJsonIntoFsmDir({
        fsmJsonPath: absPath,
        fsmName,
        fsmVersion,
        writeRootAbsPath,
        force: options.force,
      });
    }

    logger.info(
      "Writing async-worker/ + sync-worker/ for {fsmName}/{fsmVersion} under {writeRootAbsPath}",
      { fsmName, fsmVersion, writeRootAbsPath },
    );
    await generateAsyncOperationLogicFromFsmJson(
      fsmJsonPath,
      writeRootAbsPath,
      fsmName,
      fsmVersion,
    );
    await generateSyncOperationLogicFromFsmJson(
      fsmJsonPath,
      writeRootAbsPath,
      fsmName,
      fsmVersion,
      langs,
    );
    return;
  }

  // Folder mode: run all three steps across the whole tree. See the
  // doc-comment above for why each step's AggregateError is caught rather
  // than left to propagate immediately.
  const stepErrors: Error[] = [];

  try {
    await generateFsmJSONFromFolders(folder, skipDirs, showRecommendation);
  } catch (err) {
    stepErrors.push(err instanceof Error ? err : new Error(String(err)));
  }

  try {
    await generateAsyncOperationLogicFromFolders(
      folder,
      skipDirs,
      writeRootAbsPath,
    );
  } catch (err) {
    stepErrors.push(err instanceof Error ? err : new Error(String(err)));
  }

  try {
    await generateSyncOperationLogicFromFolders(
      folder,
      langs,
      skipDirs,
      writeRootAbsPath,
    );
  } catch (err) {
    stepErrors.push(err instanceof Error ? err : new Error(String(err)));
  }

  if (stepErrors.length > 0) {
    throw new AggregateError(
      stepErrors,
      `generate-all failed for ${stepErrors.length} step(s) under ${folder}`,
    );
  }
}
