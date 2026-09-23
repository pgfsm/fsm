import { getLogger } from "@logtape/logtape";
import {
  generateFsmJSONFromFolders,
  generateFsmJSONFromMachineFile,
} from "./generate-fsm-json.ts";
import {
  generateAsyncOperationLogicFromFolders,
  generateAsyncOperationLogicFromFsmJson,
} from "./generate-async-operation-logic.ts";
import {
  generateSyncOperationLogicFromFolders,
  generateSyncOperationLogicFromFsmJson,
} from "./generate-sync-operation-logic.ts";
import {
  fsmIdentityFromVersionFolderPath,
  oneLevelUp,
  resolvePluginRootAbsPath,
} from "./operation-logic-scaffold.ts";
import type { OperationLang, WorkerSdkProtocol } from "./types/index.ts";

const logger = getLogger(["@pgfsm/compiler", "generate-all"]);

export interface GenerateAllOptions {
  /**
   * Path to a plugin-root folder, a single machine.ts file, or a single
   * fsm.json file. Relative paths are resolved against `Deno.cwd()`.
   */
  folder: string;
  /**
   * Version folder to write generated output into. Required when `folder` is
   * a single machine.ts or fsm.json file; ignored (each versioned FSM folder
   * under `folder` is written into directly) when `folder` is a plugin-root
   * folder.
   */
  output?: string;
  /** Subdirectory names to skip while walking a plugin-root folder. */
  skipDirs?: string[];
  /**
   * Validates generated fsm.json against the machine schema and logs issues.
   * Only applies to the generate-fsm-json step.
   */
  showRecommendation?: boolean;
  /** Sidecar wire protocol for generated worker SDKs. Defaults to `"grpc"`. */
  workerSdkProtocol?: WorkerSdkProtocol;
  /** Language(s) to scaffold sync operation logic (actions/guards/delays) in. Defaults to `["typescript"]`. */
  langs?: OperationLang[];
}

/**
 * Runs generate-fsm-json, then generate-async-logic, then generate-sync-logic
 * in sequence, for a plugin-root folder, a single machine.ts file, or a
 * single fsm.json file — whichever `options.folder` points at. Backs the
 * CLI's `generate-all` command; also usable directly from an npm/npx
 * consumer.
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
 * - **Single machine.ts file mode** (`folder` is a `.ts` file; `output`
 *   required): chains all three steps for just this one FSM version. `output`
 *   is the destination for `fsm.json`/`xstate-fsm.json`; the actor stubs +
 *   aggregate registry and the sync stubs also write under `output`, but
 *   nested `async-worker/<lang>/<fsmName>/<fsmVersion>/` /
 *   `sync-worker/<lang>/<fsmName>/<fsmVersion>/` deep rather than directly
 *   into it (`fsmName`/`fsmVersion` derived from `output`'s own path, same
 *   convention the aggregate step already relies on) — a step's failure here
 *   simply aborts, since there's only one FSM and nothing left for a later
 *   step to still succeed on.
 * - **Single fsm.json file mode** (`folder` is a `.json` file; `output`
 *   required): the fsm.json already exists, so generate-fsm-json is skipped
 *   entirely and only generate-async-logic/generate-sync-logic run against
 *   it, mirroring generate-async-logic/generate-sync-logic's own
 *   single-fsm.json mode.
 */
export async function generateAll(options: GenerateAllOptions): Promise<void> {
  const {
    folder,
    output,
    skipDirs = [],
    showRecommendation = false,
    workerSdkProtocol = "grpc",
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

  if ((folderIsFsmJsonFile || folderIsMachineTsFile) && !output) {
    throw new Error(
      `generate-all requires --output <version-folder> when --folder is a single ${
        folderIsFsmJsonFile ? "fsm.json" : "machine.ts"
      } file`,
    );
  }

  if (folderIsFsmJsonFile) {
    // fsm.json already exists (folder points straight at it) — skip
    // generateFsmJSONFromMachineFile entirely and run only the remaining two
    // steps against the provided file, mirroring generate-async-logic/
    // generate-sync-logic's own single-fsm.json mode.
    const versionFolderPath = resolvePluginRootAbsPath(output!);
    // fsm.json is expected at the conventional <pluginRoot>/<fsmName>/<version>
    // depth (same assumption generateAsyncOperationLogicFromFsmJson's own
    // realPluginRootAbsPath derivation makes) -- both generate-async-logic's
    // and generate-sync-logic's single-file modes need fsmName/fsmVersion
    // explicitly now, unlike --output, which can point anywhere.
    const absFsmJsonPath = folder.startsWith("/")
      ? folder
      : `${Deno.cwd()}/${folder}`;
    const absFsmJsonDir = absFsmJsonPath.substring(
      0,
      absFsmJsonPath.lastIndexOf("/"),
    );
    const fsmIdentity = fsmIdentityFromVersionFolderPath(absFsmJsonDir);
    logger.info(
      "--folder is an fsm.json file: skipping generate-fsm-json and writing async-worker/ + sync-worker/ under {versionFolderPath}",
      { versionFolderPath },
    );
    await generateAsyncOperationLogicFromFsmJson(
      folder,
      versionFolderPath,
      fsmIdentity.fsmName,
      fsmIdentity.fsmVersion,
      workerSdkProtocol,
    );
    await generateSyncOperationLogicFromFsmJson(
      folder,
      versionFolderPath,
      fsmIdentity.fsmName,
      fsmIdentity.fsmVersion,
      langs,
    );
    return;
  }

  if (folderIsMachineTsFile) {
    // Single-file mode: chain all three steps for just this one FSM version,
    // output serving as the destination for every step alike (fsm.json/
    // xstate-fsm.json, actor stubs + aggregate registry, sync stubs) — a
    // step's failure here simply aborts (there's only one FSM, so there's
    // nothing left for a later step to still succeed on).
    const absPath = folder.startsWith("/") ? folder : `${Deno.cwd()}/${folder}`;
    const absDir = absPath.substring(0, absPath.lastIndexOf("/"));
    const fsmIdentity = fsmIdentityFromVersionFolderPath(absDir);
    const versionFolderPath = resolvePluginRootAbsPath(output!);

    await generateFsmJSONFromMachineFile(
      absDir,
      fsmIdentity.fsmVersion,
      showRecommendation,
      versionFolderPath,
    );
    const fsmJsonPath = `${versionFolderPath}/fsm.json`;
    await generateAsyncOperationLogicFromFsmJson(
      fsmJsonPath,
      versionFolderPath,
      fsmIdentity.fsmName,
      fsmIdentity.fsmVersion,
      workerSdkProtocol,
    );
    await generateSyncOperationLogicFromFsmJson(
      fsmJsonPath,
      versionFolderPath,
      fsmIdentity.fsmName,
      fsmIdentity.fsmVersion,
      langs,
    );
    return;
  }

  // Folder mode: run all three steps across the whole tree. See the
  // doc-comment above for why each step's AggregateError is caught rather
  // than left to propagate immediately.
  const stepErrors: Error[] = [];

  // Shared by the async- and sync-logic steps below: one level above --folder
  // (the app root), matching the on-disk layout apps/fsm-core-example/ uses
  // -- async-worker/ and sync-worker/ both sit beside the fsm/ plugin-root
  // folder, not inside it.
  const writeRootAbsPath = oneLevelUp(resolvePluginRootAbsPath(folder));

  try {
    await generateFsmJSONFromFolders(folder, skipDirs, showRecommendation);
  } catch (err) {
    stepErrors.push(err instanceof Error ? err : new Error(String(err)));
  }

  try {
    await generateAsyncOperationLogicFromFolders(
      folder,
      skipDirs,
      workerSdkProtocol,
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
