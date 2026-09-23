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
 * Reserved subfolder name every `generate-sync-logic` output nests under,
 * inside the version folder — `<versionFolder>/sync-worker/<lang>/...` rather
 * than `<versionFolder>/<lang>/...` directly. Parity with how
 * `generate-async-logic` reserves `worker-sdk-generated/` for its own output
 * (see `operation-logic-scaffold.ts`'s `WORKER_SDK_DIR_NAME`), giving sync
 * logic its own namespaced subtree instead of dumping per-language folders
 * straight into the version root.
 */
const SYNC_WORKER_DIR_NAME = "sync-worker";

/**
 * Writes action/guard/delay stubs for one already-parsed fsm.json into
 * `<absVersionFolderPath>/sync-worker/`, in each of `langs` — plus, for
 * `typescript`, that version's `generated-sync-operation-registry.ts`
 * combining all three into one self-describing
 * `SyncOperationRegistration[]` (see {@linkcode writeSyncOperationRegistry})
 * and a copy of `fsm.json` itself, so `sync-worker/typescript/` is
 * self-contained rather than requiring a caller to also reach back up to the
 * version folder root for the FSM definition it's registering against
 * (TypeScript only, matching `generate-sync-logic`'s own current scope).
 * Re-serialized from the already-parsed `fsmData` — same
 * `JSON.stringify(fsmData, null, 2) + "\n"` convention
 * `generate-fsm-json.ts` writes the original with — rather than copying
 * bytes from a source path, since single-file `--output` mode has no fixed
 * source `fsm.json` location relative to `absVersionFolderPath` to copy from.
 * Shared by {@linkcode generateSyncOperationLogicFromFolders} (one call per
 * versioned FSM folder it walks) and
 * {@linkcode generateSyncOperationLogicFromFsmJson} (a single call for one
 * fsm.json). Mutates `tsFiles` in place so callers can batch-format
 * everything written across a whole run (see {@linkcode formatTsFilesBestEffort}).
 */
async function scaffoldSyncLogicForVersion(
  absVersionFolderPath: string,
  fsmData: FsmMachineJson,
  langs: OperationLang[],
  tsFiles: string[],
): Promise<void> {
  const { actions, guards, delays } = extractFsmPluginRefs(fsmData);
  // xstate.raise / xstate.cancel are built-ins, not user code.
  const filteredActions = actions.filter((a) => !RAISE_CANCEL.has(a));
  const absSyncWorkerFolderPath =
    `${absVersionFolderPath}/${SYNC_WORKER_DIR_NAME}`;

  for (const lang of langs) {
    await writeOperationModule(
      absSyncWorkerFolderPath,
      lang,
      "actions",
      filteredActions,
    );
    await writeOperationModule(
      absSyncWorkerFolderPath,
      lang,
      "guards",
      guards,
    );
    await writeOperationModule(
      absSyncWorkerFolderPath,
      lang,
      "delays",
      delays,
    );
    logger.info("Wrote {lang} action/guard/delay stubs in {path}", {
      lang,
      path: absSyncWorkerFolderPath,
    });

    if (lang === "typescript") {
      const { fsmName, fsmVersion } = fsmIdentityFromVersionFolderPath(
        absVersionFolderPath,
      );
      const registryFile = await writeSyncOperationRegistry(
        `${absSyncWorkerFolderPath}/${lang}`,
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

      const fsmJsonCopyFile = `${absSyncWorkerFolderPath}/${lang}/fsm.json`;
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
 * FSM under `folderPath`, in each of the requested `langs`.
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
      await scaffoldSyncLogicForVersion(absFolderPath, fsmData, langs, tsFiles);
    },
  );

  await formatTsFilesBestEffort(tsFiles);
}

/**
 * Scaffolds sync operation logic for a single fsm.json file, for the CLI's
 * single-file `--folder` mode — used when the caller wants to target one
 * fsm.json directly instead of walking a plugin-root folder for every
 * versioned FSM under it. `absVersionFolderPath` is the folder stubs are
 * written into (the CLI resolves it from `--output`, independently of
 * `fsmJsonPath`'s own location); it does not have to be `fsmJsonPath`'s own
 * containing directory.
 */
export async function generateSyncOperationLogicFromFsmJson(
  fsmJsonPath: string,
  absVersionFolderPath: string,
  langs: OperationLang[],
): Promise<void> {
  logger.info(
    "Scaffolding sync operation logic ({langs}) from {path} into {versionFolder}",
    {
      langs: langs.join(", "),
      path: fsmJsonPath,
      versionFolder: absVersionFolderPath,
    },
  );

  const fsmData: FsmMachineJson = JSON.parse(
    await Deno.readTextFile(fsmJsonPath),
  );
  const tsFiles: string[] = [];
  await scaffoldSyncLogicForVersion(
    absVersionFolderPath,
    fsmData,
    langs,
    tsFiles,
  );
  await formatTsFilesBestEffort(tsFiles);
}
