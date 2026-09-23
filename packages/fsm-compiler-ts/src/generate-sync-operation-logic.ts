import { getLogger } from "@logtape/logtape";
import { extractFsmPluginRefs, RAISE_CANCEL } from "./util.ts";
import {
  eachVersionedFsmFolder,
  formatTsFilesBestEffort,
  fsmIdentityFromVersionFolderPath,
  writeOperationModule,
  writeSyncOperationRegistry,
} from "./operation-logic-scaffold.ts";
import type {
  FsmMachineJson,
  OperationLang,
  WorkflowType,
} from "./types/index.ts";

const logger = getLogger(["@pgfsm/compiler", "sync-logic"]);

/**
 * Reserved subfolder name every `generate-sync-logic` output nests under —
 * `<writeRootAbsPath>/sync-worker/<lang>/<fsmName>/<fsmVersion>/...`, always
 * anchored at `writeRootAbsPath` (the CLI passes `Deno.cwd()`), never at the
 * source FSM tree's own location. Parity with how `generate-async-logic`
 * reserves `async-worker/` for its own output (see
 * `operation-logic-scaffold.ts`'s `ASYNC_WORKER_DIR_NAME`).
 */
const SYNC_WORKER_DIR_NAME = "sync-worker";

/**
 * Writes action/guard/delay stubs for one already-parsed fsm.json into
 * `<writeRootAbsPath>/sync-worker/<lang>/<fsmName>/<fsmVersion>/`, in each of
 * `langs` — plus, for `typescript`, that version's
 * `generated-sync-operation-registry.ts` (see
 * {@linkcode writeSyncOperationRegistry}) and a copy of `fsm.json` itself
 * (re-serialized from the already-parsed `fsmData` via the same
 * `JSON.stringify(fsmData, null, 2) + "\n"` convention `generate-fsm-json.ts`
 * writes the original with), so that directory is self-contained (TypeScript
 * only, matching `generate-sync-logic`'s own current scope). The
 * `<fsmName>/<fsmVersion>` nesting is what lets multiple FSMs/versions share
 * one `writeRootAbsPath` without colliding. Shared by
 * {@linkcode generateSyncOperationLogicFromFolders} (one call per versioned
 * FSM folder it walks, `fsmName`/`fsmVersion` derived from that folder's own
 * path) and {@linkcode generateSyncOperationLogicFromFsmJson} (a single call
 * for one fsm.json, `fsmName`/`fsmVersion` caller-supplied since single-file
 * mode has no `<fsmName>/<fsmVersion>/fsm.json` folder structure to infer
 * them from). Mutates `tsFiles` in place so callers can batch-format
 * everything written across a whole run (see {@linkcode formatTsFilesBestEffort}).
 */
async function scaffoldSyncLogicForVersion(
  writeRootAbsPath: string,
  fsmName: string,
  fsmVersion: string,
  fsmData: FsmMachineJson,
  langs: OperationLang[],
  tsFiles: string[],
): Promise<void> {
  const { actions, guards, delays } = extractFsmPluginRefs(fsmData);
  // xstate.raise / xstate.cancel are built-ins, not user code.
  const filteredActions = actions.filter((a) => !RAISE_CANCEL.has(a));
  const absSyncWorkerRootPath = `${writeRootAbsPath}/${SYNC_WORKER_DIR_NAME}`;
  const fsmVersionSubPath = `${fsmName}/${fsmVersion}`;

  for (const lang of langs) {
    await writeOperationModule(
      absSyncWorkerRootPath,
      lang,
      "actions",
      filteredActions,
      fsmVersionSubPath,
    );
    await writeOperationModule(
      absSyncWorkerRootPath,
      lang,
      "guards",
      guards,
      fsmVersionSubPath,
    );
    await writeOperationModule(
      absSyncWorkerRootPath,
      lang,
      "delays",
      delays,
      fsmVersionSubPath,
    );
    const absVersionLangOutputPath =
      `${absSyncWorkerRootPath}/${lang}/${fsmVersionSubPath}`;
    logger.info("Wrote {lang} action/guard/delay stubs in {path}", {
      lang,
      path: absVersionLangOutputPath,
    });

    if (lang === "typescript") {
      const registryFile = await writeSyncOperationRegistry(
        absVersionLangOutputPath,
        fsmName,
        fsmVersion,
        lang,
        filteredActions,
        guards,
        delays,
      );
      tsFiles.push(registryFile);
      logger.info("Wrote sync operation registry {file}", {
        file: registryFile,
      });

      const fsmJsonCopyFile = `${absVersionLangOutputPath}/fsm.json`;
      await Deno.writeTextFile(
        fsmJsonCopyFile,
        JSON.stringify(fsmData, null, 2) + "\n",
      );
      logger.info("Wrote fsm.json copy {file}", { file: fsmJsonCopyFile });
    }
  }
}

/**
 * Scaffolds sync operation logic (actions / guards / delays) for every versioned
 * FSM under `folderPath`, in each of the requested `langs`, writing into
 * `<writeRootAbsPath>/sync-worker/<lang>/<fsmName>/<fsmVersion>/` for each one
 * (the CLI passes `Deno.cwd()` for `writeRootAbsPath` — output is anchored at
 * wherever the command is invoked from, not at `folderPath`'s own location).
 * `fsmName`/`fsmVersion` are derived from each versioned FSM folder's own path
 * as {@linkcode eachVersionedFsmFolder} walks it.
 *
 * Unlike actors (which are routed by each invoke object's `asyncOperationLanguage`), sync
 * logic is generated in whatever language(s) the caller asks for — a machine's
 * actions/guards/delays can be implemented in `typescript`, `python`, `rust`, or
 * `go`.
 */
export async function generateSyncOperationLogicFromFolders(
  folderPath: string,
  langs: OperationLang[],
  skipDirs: string[] = [],
  writeRootAbsPath: string,
): Promise<void> {
  logger.info("Scaffolding sync operation logic ({langs}) from {path}", {
    langs: langs.join(", "),
    path: folderPath,
  });

  const tsFiles: string[] = [];
  await eachVersionedFsmFolder(
    folderPath,
    skipDirs,
    async (absFolderPath, fsmData) => {
      const { fsmName, fsmVersion } = fsmIdentityFromVersionFolderPath(
        absFolderPath,
      );
      await scaffoldSyncLogicForVersion(
        writeRootAbsPath,
        fsmName,
        fsmVersion,
        fsmData,
        langs,
        tsFiles,
      );
    },
  );

  await formatTsFilesBestEffort(tsFiles);
}

/**
 * Scaffolds sync operation logic for a single fsm.json file, for the CLI's
 * single-file `--folder` mode — used when the caller wants to target one
 * fsm.json directly instead of walking a plugin-root folder for every
 * versioned FSM under it. Unlike folder mode, there's no
 * `<fsmName>/<fsmVersion>/fsm.json` directory structure to infer identity
 * from, so `fsmName`/`fsmVersion` are caller-supplied (the CLI requires
 * `--fsm-name`/`--fsm-version` for this mode, mirroring
 * `validate-sync-operation`'s own single-file-mode flags). Writes into
 * `<writeRootAbsPath>/sync-worker/<lang>/<fsmName>/<fsmVersion>/` (the CLI
 * passes `Deno.cwd()` for `writeRootAbsPath`), independent of both
 * `fsmJsonPath`'s own location and `fsmName`/`fsmVersion`'s.
 */
export async function generateSyncOperationLogicFromFsmJson(
  fsmJsonPath: string,
  writeRootAbsPath: string,
  fsmName: string,
  fsmVersion: string,
  langs: OperationLang[],
): Promise<void> {
  logger.info(
    "Scaffolding sync operation logic ({langs}) from {path} into {writeRootAbsPath}",
    {
      langs: langs.join(", "),
      path: fsmJsonPath,
      writeRootAbsPath,
    },
  );

  const fsmData: FsmMachineJson = JSON.parse(
    await Deno.readTextFile(fsmJsonPath),
  );
  const tsFiles: string[] = [];
  await scaffoldSyncLogicForVersion(
    writeRootAbsPath,
    fsmName,
    fsmVersion,
    fsmData,
    langs,
    tsFiles,
  );
  await formatTsFilesBestEffort(tsFiles);
}
