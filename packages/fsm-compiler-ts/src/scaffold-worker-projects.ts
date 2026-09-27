import { getLogger } from "@logtape/logtape";
import {
  ASYNC_WORKER_DIR_NAME,
  collectRegisteredActorsFromAsyncWorkerDir,
  formatGoFilesBestEffort,
  formatRustFilesBestEffort,
  formatTsFilesBestEffort,
  goModTidyManyBestEffort,
  SUPPORTED_OPERATION_LANGS,
  writeAggregateActorsRegistry,
  writeAggregateGoRegistry,
  writeAggregateSyncOperationRegistry,
  writeSyncWorkerRunner,
  writeWorkerSdk,
} from "./operation-logic-scaffold.ts";
import type { OperationLang } from "./types/index.ts";
import { withWritePolicy } from "./write-policy.ts";
import type { WritePolicyOptions } from "./write-policy.ts";

const logger = getLogger(["@pgfsm/compiler", "scaffold-worker-projects"]);

export interface ScaffoldWorkerProjectsOptions extends WritePolicyOptions {
  /** Root `sync-worker/` and `async-worker/` are written under. */
  writeRootAbsPath: string;
  /**
   * Logical Go module root every actor module names itself under — the
   * project directory's own name, matching what `generate-async-logic`
   * derives from a `<root>/fsm/<fsmName>/<fsmVersion>/` tree.
   */
  goModuleAppRoot: string;
  /** Async-worker languages to lay down. Defaults to all four. */
  asyncLangs?: OperationLang[];
  /** `sync-worker/typescript/deno.json`'s `name`. Random when omitted. */
  projectName?: string;
}

/**
 * Lays down a runnable worker project for every requested language before
 * any FSM needs it (#382, SPEC-004 `create`): `sync-worker/typescript/` and
 * `async-worker/<lang>/` for each of `asyncLangs`, each with its entry file,
 * manifest, and an aggregate registry — empty for a language no actor uses
 * yet. Whatever is already on disk (actors, sync-operation groups) is
 * included, so it's safe to call on an existing tree. Later
 * `generate-*` runs leave a language with no actors untouched, so these
 * empty projects persist until an FSM starts using that language.
 */
export function scaffoldWorkerProjects(
  options: ScaffoldWorkerProjectsOptions,
): Promise<void> {
  return withWritePolicy(options, async () => {
    const {
      writeRootAbsPath,
      goModuleAppRoot,
      asyncLangs = SUPPORTED_OPERATION_LANGS,
      projectName,
    } = options;
    const tsFiles: string[] = [];
    const rustFiles: string[] = [];
    const goFiles: string[] = [];
    const goModDirs: string[] = [];

    const syncDir = `${writeRootAbsPath}/sync-worker/typescript`;
    const syncAggregate = await writeAggregateSyncOperationRegistry(
      syncDir,
      true,
    );
    if (syncAggregate) tsFiles.push(syncAggregate);
    const { runFile } = await writeSyncWorkerRunner(syncDir, projectName);
    tsFiles.push(runFile);

    const actors = await collectRegisteredActorsFromAsyncWorkerDir(
      writeRootAbsPath,
    );
    for (const lang of asyncLangs) {
      if (lang === "go") {
        const goRegistry = await writeAggregateGoRegistry(
          writeRootAbsPath,
          goModuleAppRoot,
          actors,
          true,
        );
        if (goRegistry) {
          goFiles.push(goRegistry);
          goModDirs.push(goRegistry.slice(0, goRegistry.lastIndexOf("/")));
        }
        continue;
      }
      const aggregate = await writeAggregateActorsRegistry(
        writeRootAbsPath,
        actors,
        lang,
        true,
      );
      if (aggregate && lang === "typescript") tsFiles.push(aggregate);
      if (aggregate && lang === "rust") rustFiles.push(aggregate);
    }

    const wrote = await writeWorkerSdk(
      writeRootAbsPath,
      goModuleAppRoot,
      actors,
      asyncLangs,
    );
    tsFiles.push(...wrote.tsFiles);
    rustFiles.push(...wrote.rustFiles);
    goFiles.push(...wrote.goFiles);
    if (wrote.goModDir) goModDirs.push(wrote.goModDir);

    await formatTsFilesBestEffort(tsFiles);
    await formatRustFilesBestEffort(rustFiles);
    await formatGoFilesBestEffort(goFiles);
    await goModTidyManyBestEffort(goModDirs);

    logger.info(
      "Scaffolded sync-worker/typescript and {asyncWorkerDir}/{langs} under {root}",
      {
        asyncWorkerDir: ASYNC_WORKER_DIR_NAME,
        langs: `{${asyncLangs.join(",")}}`,
        root: writeRootAbsPath,
      },
    );
  });
}
