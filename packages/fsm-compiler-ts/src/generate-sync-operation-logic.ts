import { getLogger } from "@logtape/logtape";
import {
  extractFsmPluginRefs,
  RAISE_CANCEL,
  type WorkflowType,
} from "./util.ts";
import {
  eachVersionedFsmFolder,
  type OperationLang,
  writeOperationModule,
} from "./operation-logic-scaffold.ts";

const logger = getLogger(["@pgfsm/compiler", "sync-logic"]);

/**
 * Scaffolds sync operation logic (actions / guards / delays) for every versioned
 * FSM under `folderPath`, in each of the requested `langs`.
 *
 * Unlike actors (which are routed by each invoke object's `fsmLanguage`), sync
 * logic is generated in whatever language(s) the caller asks for — a machine's
 * actions/guards/delays can be implemented in `typescript`, `python`, `rust`, or
 * `go`.
 */
export async function generateSyncOperationLogicFromFolders(
  folderPath: string,
  _workflowType: WorkflowType,
  langs: OperationLang[],
  skipDirs: string[] = [],
): Promise<void> {
  logger.info("Scaffolding sync operation logic ({langs}) from {path}", {
    langs: langs.join(", "),
    path: folderPath,
  });

  await eachVersionedFsmFolder(
    folderPath,
    skipDirs,
    async (absFolderPath, fsmData) => {
      const { actions, guards, delays } = extractFsmPluginRefs(fsmData);
      // xstate.raise / xstate.cancel are built-ins, not user code.
      const filteredActions = actions.filter((a) => !RAISE_CANCEL.has(a));

      for (const lang of langs) {
        await writeOperationModule(
          absFolderPath,
          lang,
          "actions",
          filteredActions,
        );
        await writeOperationModule(absFolderPath, lang, "guards", guards);
        await writeOperationModule(absFolderPath, lang, "delays", delays);
        logger.info("Wrote {lang} action/guard/delay stubs in {path}", {
          lang,
          path: absFolderPath,
        });
      }
    },
  );
}
