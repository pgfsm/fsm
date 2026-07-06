import { getLogger } from "@logtape/logtape";
import { extractFsmPluginRefs, type WorkflowType } from "./util.ts";
import {
  actorFileBaseName,
  eachVersionedFsmFolder,
  isOperationLang,
  writeActorFile,
} from "./operation-logic-scaffold.ts";

const logger = getLogger(["@pgfsm/compiler", "async-logic"]);

/**
 * Scaffolds async operation logic (actors / invoke objects) for every versioned
 * FSM under `folderPath`.
 *
 * Each invoke object gets its **own file** at
 * `<lang>/actors/<fsmType>_<fsmVersion>_<src>.<ext>`, where `<lang>` is the
 * actor's `fsmLanguage` (defaulting to typescript). The file exports one
 * function named after the actor `src`. Invokes that resolve to the same
 * `<fsmType>_<fsmVersion>_<src>` within a language are written once.
 */
export async function generateAsyncOperationLogicFromFolders(
  folderPath: string,
  _workflowType: WorkflowType,
  skipDirs: string[] = [],
): Promise<void> {
  logger.info("Scaffolding async operation logic from {path}", {
    path: folderPath,
  });

  await eachVersionedFsmFolder(
    folderPath,
    skipDirs,
    async (absFolderPath, fsmData) => {
      const { actors } = extractFsmPluginRefs(fsmData);

      // Dedupe by language + `<fsmType>_<fsmVersion>_<src>` so identical invokes
      // are written once, while actors that differ in type/version/src get
      // their own files.
      const seen = new Set<string>();
      let written = 0;
      for (const actor of actors) {
        const fsmType = actor.fsmType ?? "promise";
        if (fsmType !== "promise") {
          logger.info(
            "Skipping actor {src}: fsmType is {fsmType}, not promise",
            { src: actor.src, fsmType },
          );
          continue;
        }
        const lang = actor.fsmLanguage ?? "typescript";
        if (!isOperationLang(lang)) {
          logger.warning(
            "Skipping actor {src}: unsupported fsmLanguage {lang}",
            {
              src: actor.src,
              lang,
            },
          );
          continue;
        }
        const key = `${lang}/${actorFileBaseName(actor)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const file = await writeActorFile(absFolderPath, lang, actor);
        written++;
        logger.info("Wrote actor file {file}", { file });
      }

      logger.info("Wrote {count} actor file(s) in {path}", {
        count: written,
        path: absFolderPath,
      });
    },
  );
}
