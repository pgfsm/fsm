import { getLogger } from "@logtape/logtape";

const logger = getLogger(["@pgfsm/compiler", "validate"]);

import {
  isOperationLang,
  type OperationLang,
  operationModuleFileName,
} from "./operation-logic-scaffold.ts";
import {
  type ActorReference,
  extractFsmPluginRefs,
  type FailedMethod,
  type FsmPluginValidationResult,
  isVersionFolderName,
  type WorkflowType,
} from "./util.ts";
import type { Json } from "@pgfsm/db/database.types";

export async function validateAsyncOperationFromFolder(
  fsmData: Json,
  dirName: string,
  versionName: string,
  absPath: string,
  relPath: string,
  parentDirName: string,
  parentAbsPath: string,
  parentRelPath: string,
  workflowType: WorkflowType,
  availableActors: ActorReference[],
): Promise<FsmPluginValidationResult> {
  const failedMethods: FailedMethod[] = [];
  const modules: Record<string, any> = {};

  const { actors } = extractFsmPluginRefs(fsmData as any);

  // Group actor srcs by their declared fsmLanguage
  const srcsByLang = new Map<OperationLang, Set<string>>();
  for (const actor of actors) {
    const lang = actor.fsmLanguage ?? "typescript";
    if (!isOperationLang(lang)) {
      logger.warning(
        "Skipping actor {src}: unsupported fsmLanguage {lang}",
        { src: actor.src, lang },
      );
      continue;
    }
    if (!srcsByLang.has(lang)) srcsByLang.set(lang, new Set());
    srcsByLang.get(lang)!.add(actor.src);
  }

  for (const [lang, srcs] of srcsByLang) {
    const modulePath = `${absPath}/${lang}/actors/${
      operationModuleFileName(lang)
    }`;

    if (lang === "typescript") {
      try {
        const mod = await import(`file://${modulePath}`);
        modules[lang] = mod;
        for (const src of srcs) {
          if (typeof mod[src] !== "function") {
            logger.info(
              "actors/typescript does not export {src} as a function",
              { src },
            );
            failedMethods.push({
              method: src,
              moduleType: "actors/typescript",
              modulePath,
            });
          } else {
            logger.info(
              "actors/typescript exports {src} as a function",
              { src },
            );
          }
        }
      } catch (err) {
        logger.error(
          "Failed to import actors/typescript from {path}: {error}",
          { path: modulePath, error: err },
        );
        modules[lang] = null;
        for (const src of srcs) {
          failedMethods.push({
            method: src,
            moduleType: "actors/typescript",
            modulePath,
          });
        }
      }
    } else {
      // For non-TypeScript languages, verify the module file exists
      try {
        await Deno.stat(modulePath);
        modules[lang] = modulePath;
        logger.info(
          "actors/{lang} module exists at {path}",
          { lang, path: modulePath },
        );
      } catch {
        logger.error(
          "actors/{lang} module missing at {path}",
          { lang, path: modulePath },
        );
        for (const src of srcs) {
          failedMethods.push({
            method: src,
            moduleType: `actors/${lang}`,
            modulePath,
          });
        }
      }
    }
  }

  return {
    src: dirName,
    fsmName: dirName,
    fsmVersion: versionName,
    fsmType: workflowType,
    fsmAbsFolderPath: absPath,
    fsmRelativeFolderPath: relPath,
    fsmParentDirName: parentDirName,
    fsmParentAbsFolderPath: parentAbsPath,
    fsmParentRelativeFolderPath: parentRelPath,
    fsmJsonPresent: true,
    fsmJsonFollowSchema: false,
    isFsmModuleVerified: failedMethods.length === 0,
    fsmModuleDefinition: modules,
    failedMethods,
    internalActors: [],
    externalActors: [],
  };
}

export async function validateAsyncOperationFromFolders(
  folderPath: string,
  workflowType: WorkflowType,
  skipDirs: string[] = [],
  availableActors: ActorReference[] = [],
): Promise<FsmPluginValidationResult[]> {
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

  const allFolderResults: FsmPluginValidationResult[] = [];
  try {
    const stat = await Deno.stat(absFolderPath);
    if (!stat.isDirectory) {
      throw new Error(`Provided path '${absFolderPath}' is not a directory.`);
    }
    for await (const dirEntry of Deno.readDir(absFolderPath)) {
      if (dirEntry.isDirectory) {
        if (skipDirs.includes(dirEntry.name)) continue;

        const fsmDirPath = `${absFolderPath}/${dirEntry.name}`;

        for await (const subEntry of Deno.readDir(fsmDirPath)) {
          if (subEntry.isDirectory) {
            if (isVersionFolderName(subEntry.name)) {
              try {
                const fsmJsonPath = `${fsmDirPath}/${subEntry.name}/fsm.json`;
                await Deno.stat(fsmJsonPath);
                const fsmData = JSON.parse(
                  await Deno.readTextFile(fsmJsonPath),
                );

                const folderResult = await validateAsyncOperationFromFolder(
                  fsmData,
                  dirEntry.name,
                  subEntry.name,
                  `${fsmDirPath}/${subEntry.name}`,
                  `${dirEntry.name}/${subEntry.name}`,
                  folderPath,
                  absFolderPath,
                  folderPath,
                  workflowType,
                  availableActors,
                );

                logger.info(
                  "Validation result for {dir}/{sub}: {result}",
                  {
                    dir: dirEntry.name,
                    sub: subEntry.name,
                    result: folderResult,
                  },
                );

                allFolderResults.push(folderResult);
              } catch (err) {
                logger.error("Failed to validate {path}: {error}", {
                  path: `${fsmDirPath}/${subEntry.name}`,
                  error: err,
                });
              }
            } else {
              logger.info(
                "Skipping non-versioned folder: {name} in {dir}",
                { name: subEntry.name, dir: fsmDirPath },
              );
            }
          }
        }
      }
    }
    logger.info("All folder validation results: {results}", {
      results: allFolderResults,
    });
  } catch (err) {
    logger.error(
      "Error occurred while reading directory {path}: {error}",
      { path: absFolderPath, error: err },
    );
  }

  return allFolderResults;
}
