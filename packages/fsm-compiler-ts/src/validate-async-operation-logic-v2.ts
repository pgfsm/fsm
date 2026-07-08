import { getLogger } from "@logtape/logtape";

const logger = getLogger(["@pgfsm/compiler", "validate"]);

const _checkerDir = new URL("./checkers", import.meta.url).pathname;

let _rustCheckerBin: string | null | false = null;
let _goCheckerBin: string | null | false = null;

import {
  operationFileExtension,
  type OperationLang,
} from "./operation-logic-scaffold.ts";
import {
  type ActorPluginValidationResult,
  type ActorReference,
  isVersionFolderName,
  type WorkflowType,
} from "./util.ts";

export async function validateAsyncOperationFromFoldersV2(
  folderPath: string,
  workflowType: WorkflowType,
  skipDirs: string[] = [],
  availableActors: ActorReference[] = [],
  runtimeLanguages: OperationLang[] = [],
): Promise<ActorPluginValidationResult[]> {
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

  const allFolderResults: ActorPluginValidationResult[] = [];
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
              const absVersionPath = `${fsmDirPath}/${subEntry.name}`;
              try {
                for (const lang of runtimeLanguages) {
                  const langPath = `${absVersionPath}/${lang}`;
                  try {
                    await Deno.stat(langPath);
                  } catch {
                    logger.info(
                      "Lang folder {lang} not found in {path}, skipping",
                      { lang, path: absVersionPath },
                    );
                    continue;
                  }

                  const actorsPath = `${langPath}/actors`;
                  try {
                    await Deno.stat(actorsPath);
                  } catch {
                    logger.info(
                      "Actors folder not found for {lang} in {path}, skipping",
                      { lang, path: langPath },
                    );
                    continue;
                  }

                  for await (const actorDir of Deno.readDir(actorsPath)) {
                    if (!actorDir.isDirectory) continue;

                    const ext = operationFileExtension(lang);
                    const fnName = actorDir.name;
                    const modulePath =
                      `${actorsPath}/${fnName}/${fnName}.${ext}`;

                    try {
                      await Deno.stat(modulePath);
                    } catch {
                      logger.warn(
                        "actors: expected file not found for actor {actor} in {path}, skipping",
                        { actor: fnName, path: modulePath },
                      );
                      continue;
                    }

                    let isVerified = false;
                    let errorMessage: string | null = null;

                    if (lang === "typescript") {
                      const checkerPath = `${_checkerDir}/check_fn.ts`;
                      const result = await new Deno.Command("deno", {
                        args: [
                          "run",
                          "--allow-all",
                          checkerPath,
                          modulePath,
                          fnName,
                        ],
                        stderr: "piped",
                      }).output();
                      if (result.success) {
                        isVerified = true;
                        logger.info(
                          "actors/typescript: function {src} found in {path}",
                          { src: fnName, path: modulePath },
                        );
                      } else {
                        errorMessage = new TextDecoder().decode(result.stderr)
                          .trim();
                        logger.error(
                          "actors/typescript: function {src} not found in {path}: {err}",
                          { src: fnName, path: modulePath, err: errorMessage },
                        );
                      }
                    } else if (lang === "python") {
                      const checkerPath = `${_checkerDir}/check_fn.py`;
                      const result = await new Deno.Command("python3", {
                        args: [checkerPath, modulePath, fnName],
                        stderr: "piped",
                      }).output();
                      if (result.success) {
                        isVerified = true;
                        logger.info(
                          "actors/python: function {src} found in {path}",
                          { src: fnName, path: modulePath },
                        );
                      } else {
                        errorMessage = new TextDecoder().decode(result.stderr)
                          .trim();
                        logger.error(
                          "actors/python: function {src} not found in {path}: {err}",
                          { src: fnName, path: modulePath, err: errorMessage },
                        );
                      }
                    } else if (lang === "go") {
                      if (_goCheckerBin === null) {
                        const srcPath = `${_checkerDir}/check_fn.go`;
                        const tmpDir = await Deno.makeTempDir({
                          prefix: "pgfsm_go_checker_",
                        });
                        const binPath = `${tmpDir}/check_fn`;
                        const compile = await new Deno.Command("go", {
                          args: ["build", "-o", binPath, srcPath],
                          stderr: "piped",
                        }).output();
                        if (compile.success) {
                          _goCheckerBin = binPath;
                        } else {
                          const err = new TextDecoder().decode(compile.stderr)
                            .trim();
                          logger.error("Failed to compile Go checker: {err}", {
                            err,
                          });
                          _goCheckerBin = false;
                        }
                      }
                      if (_goCheckerBin === false) {
                        errorMessage = "Go checker binary compilation failed";
                        logger.error(
                          "actors/go: checker unavailable for {src} in {path}",
                          { src: fnName, path: modulePath },
                        );
                      } else {
                        const result = await new Deno.Command(_goCheckerBin, {
                          args: [modulePath, fnName],
                          stderr: "piped",
                        }).output();
                        if (result.success) {
                          isVerified = true;
                          logger.info(
                            "actors/go: function {src} found in {path}",
                            { src: fnName, path: modulePath },
                          );
                        } else {
                          errorMessage = new TextDecoder().decode(result.stderr)
                            .trim();
                          logger.error(
                            "actors/go: function {src} not found in {path}: {err}",
                            {
                              src: fnName,
                              path: modulePath,
                              err: errorMessage,
                            },
                          );
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
                          const err = new TextDecoder().decode(compile.stderr)
                            .trim();
                          logger.error(
                            "Failed to compile Rust checker: {err}",
                            { err },
                          );
                          _rustCheckerBin = false;
                        }
                      }
                      if (_rustCheckerBin === false) {
                        errorMessage = "Rust checker binary compilation failed";
                        logger.error(
                          "actors/rust: checker unavailable for {src} in {path}",
                          { src: fnName, path: modulePath },
                        );
                      } else {
                        const result = await new Deno.Command(_rustCheckerBin, {
                          args: [modulePath, fnName],
                          stderr: "piped",
                        }).output();
                        if (result.success) {
                          isVerified = true;
                          logger.info(
                            "actors/rust: function {src} found in {path}",
                            { src: fnName, path: modulePath },
                          );
                        } else {
                          errorMessage = new TextDecoder().decode(result.stderr)
                            .trim();
                          logger.error(
                            "actors/rust: function {src} not found in {path}: {err}",
                            {
                              src: fnName,
                              path: modulePath,
                              err: errorMessage,
                            },
                          );
                        }
                      }
                    }

                    allFolderResults.push({
                      src: fnName,
                      method: fnName,
                      fsmName: fnName,
                      fsmType: "promise",
                      fsmVersion: subEntry.name,
                      fsmLanguage: lang,
                      isVerified,
                      fsmModulePath: modulePath,
                      parentFsmName: dirEntry.name,
                      parentFsmVersion: subEntry.name,
                      comment:
                        "for fsmType promise fsmVersion will be its parentFsmVersion value",
                      parentFsmPath: fsmDirPath,
                      errorMessage,
                    });
                  }
                }
              } catch (err) {
                logger.error("Failed to validate {path}: {error}", {
                  path: absVersionPath,
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
  } catch (err) {
    logger.error(
      "Error occurred while reading directory {path}: {error}",
      { path: absFolderPath, error: err },
    );
  }

  return allFolderResults;
}
