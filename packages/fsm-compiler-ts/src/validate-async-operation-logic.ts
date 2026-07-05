import { getLogger } from "@logtape/logtape";

const logger = getLogger(["@pgfsm/compiler", "validate"]);

const _checkerDir = new URL("./checkers", import.meta.url).pathname;

// Lazily compiled checker binaries: null = not yet compiled, false = compile failed.
let _rustCheckerBin: string | null | false = null;
let _goCheckerBin: string | null | false = null;

import {
  isOperationLang,
  operationFileExtension,
  type OperationLang,
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
  langs: OperationLang[] = [],
): Promise<FsmPluginValidationResult> {
  const failedMethods: FailedMethod[] = [];
  const modules: Record<string, any> = {};

  const { actors } = extractFsmPluginRefs(fsmData as any);

  for (const actor of actors) {
    const lang = actor.fsmLanguage ?? "typescript";
    if (!isOperationLang(lang)) {
      logger.warning(
        "Skipping actor {src}: unsupported fsmLanguage {lang}",
        { src: actor.src, lang },
      );
      continue;
    }
    if (langs.length > 0 && !langs.includes(lang)) {
      logger.info(
        "Skipping actor {src}: language {lang} not in requested langs",
        { src: actor.src, lang },
      );
      continue;
    }

    const ext = operationFileExtension(lang);
    const actorFileName = `${actor.fsmType}_${versionName}_${actor.src}.${ext}`;
    const modulePath = `${absPath}/${lang}/actors/${actorFileName}`;

    if (lang === "typescript") {
      const checkerPath = `${_checkerDir}/check_fn.ts`;
      const result = await new Deno.Command("deno", {
        args: ["run", "--allow-all", checkerPath, modulePath, actor.src],
        stderr: "piped",
      }).output();
      if (result.success) {
        modules[actor.src] = modulePath;
        logger.info(
          "actors/typescript: function {src} found in {path}",
          { src: actor.src, path: modulePath },
        );
      } else {
        const err = new TextDecoder().decode(result.stderr).trim();
        logger.error(
          "actors/typescript: function {src} not found in {path}: {err}",
          { src: actor.src, path: modulePath, err },
        );
        modules[actor.src] = null;
        failedMethods.push({
          method: actor.src,
          moduleType: "actors/typescript",
          modulePath,
        });
      }
    } else if (lang === "python") {
      const checkerPath = `${_checkerDir}/check_fn.py`;
      const result = await new Deno.Command("python3", {
        args: [checkerPath, modulePath, actor.src],
        stderr: "piped",
      }).output();
      if (result.success) {
        modules[actor.src] = modulePath;
        logger.info(
          "actors/python: function {src} found in {path}",
          { src: actor.src, path: modulePath },
        );
      } else {
        const err = new TextDecoder().decode(result.stderr).trim();
        logger.error(
          "actors/python: function {src} not found in {path}: {err}",
          { src: actor.src, path: modulePath, err },
        );
        failedMethods.push({
          method: actor.src,
          moduleType: "actors/python",
          modulePath,
        });
      }
    } else if (lang === "go") {
      if (_goCheckerBin === null) {
        const srcPath = `${_checkerDir}/check_fn.go`;
        const tmpDir = await Deno.makeTempDir({ prefix: "pgfsm_go_checker_" });
        const binPath = `${tmpDir}/check_fn`;
        const compile = await new Deno.Command("go", {
          args: ["build", "-o", binPath, srcPath],
          stderr: "piped",
        }).output();
        if (compile.success) {
          _goCheckerBin = binPath;
        } else {
          const err = new TextDecoder().decode(compile.stderr).trim();
          logger.error("Failed to compile Go checker: {err}", { err });
          _goCheckerBin = false;
        }
      }
      if (_goCheckerBin === false) {
        failedMethods.push({
          method: actor.src,
          moduleType: "actors/go",
          modulePath,
        });
      } else {
        const result = await new Deno.Command(_goCheckerBin, {
          args: [modulePath, actor.src],
          stderr: "piped",
        }).output();
        if (result.success) {
          modules[actor.src] = modulePath;
          logger.info(
            "actors/go: function {src} found in {path}",
            { src: actor.src, path: modulePath },
          );
        } else {
          const err = new TextDecoder().decode(result.stderr).trim();
          logger.error(
            "actors/go: function {src} not found in {path}: {err}",
            { src: actor.src, path: modulePath, err },
          );
          failedMethods.push({
            method: actor.src,
            moduleType: "actors/go",
            modulePath,
          });
        }
      }
    } else if (lang === "rust") {
      if (_rustCheckerBin === null) {
        const srcPath = `${_checkerDir}/check_fn.rs`;
        const tmpDir = await Deno.makeTempDir({
          prefix: "pgfsm_rust_checker_",
        });
        const binPath = `${tmpDir}/check_fn`;
        const compile = await new Deno.Command("rustc", {
          args: [srcPath, "-o", binPath],
          stderr: "piped",
        }).output();
        if (compile.success) {
          _rustCheckerBin = binPath;
        } else {
          const err = new TextDecoder().decode(compile.stderr).trim();
          logger.error("Failed to compile Rust checker: {err}", { err });
          _rustCheckerBin = false;
        }
      }
      if (_rustCheckerBin === false) {
        failedMethods.push({
          method: actor.src,
          moduleType: "actors/rust",
          modulePath,
        });
      } else {
        const result = await new Deno.Command(_rustCheckerBin, {
          args: [modulePath, actor.src],
          stderr: "piped",
        }).output();
        if (result.success) {
          modules[actor.src] = modulePath;
          logger.info(
            "actors/rust: function {src} found in {path}",
            { src: actor.src, path: modulePath },
          );
        } else {
          const err = new TextDecoder().decode(result.stderr).trim();
          logger.error(
            "actors/rust: function {src} not found in {path}: {err}",
            { src: actor.src, path: modulePath, err },
          );
          failedMethods.push({
            method: actor.src,
            moduleType: "actors/rust",
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
  langs: OperationLang[] = [],
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
                  langs,
                );

                // logger.info(
                //   "Validation result for {dir}/{sub}: {result}",
                //   {
                //     dir: dirEntry.name,
                //     sub: subEntry.name,
                //     result: folderResult,
                //   },
                // );

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
    // logger.info("All folder validation results: {results}", {
    //   results: allFolderResults,
    // });
  } catch (err) {
    logger.error(
      "Error occurred while reading directory {path}: {error}",
      { path: absFolderPath, error: err },
    );
  }

  return allFolderResults;
}
