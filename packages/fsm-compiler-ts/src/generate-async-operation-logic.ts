import { getLogger } from "@logtape/logtape";
import { extractFsmPluginRefs } from "./util.ts";
import {
  actorFileBaseName,
  eachVersionedFsmFolder,
  formatGoFilesBestEffort,
  formatRustFilesBestEffort,
  formatTsFilesBestEffort,
  goModTidyManyBestEffort,
  isOperationLang,
  resolvePluginRootAbsPath,
  toRegisteredActor,
  writeActorFile,
  writeActorsBarrel,
  writeActorsManifest,
  writeActorsRegistry,
  writeAggregateActorsRegistry,
  writeAggregateGoRegistry,
  writeWorkerSdk,
} from "./operation-logic-scaffold.ts";
import type {
  ActorReference,
  ActorsBarrelLang,
  FsmMachineJson,
  OperationLang,
  RegisteredActor,
  WorkerSdkProtocol,
  WorkflowType,
} from "./types/index.ts";

const logger = getLogger(["@pgfsm/compiler", "async-logic"]);

const BARREL_LANGS: ActorsBarrelLang[] = ["typescript", "python", "rust"];

/**
 * Selects the invoke-object actors from one fsm.json that get their own
 * scaffolded file: `internalAsyncOperation` only, a supported
 * `asyncOperationLanguage`, deduped by language +
 * `<asyncOperationType>_<asyncOperationVersion>_<src>` so identical invokes
 * resolve to one file while actors differing in type/version/src get their
 * own. Pure (no I/O) so it can be reused both when actually writing a
 * version's files ({@linkcode scaffoldAsyncLogicForVersion}) and when only
 * re-deriving a sibling version's already-written actors for the aggregate
 * step ({@linkcode deriveRegisteredActorsForVersion}).
 */
function selectRegisterableActors(
  fsmData: FsmMachineJson,
): { actor: ActorReference; lang: OperationLang }[] {
  const { actors } = extractFsmPluginRefs(fsmData);
  const seen = new Set<string>();
  const selected: { actor: ActorReference; lang: OperationLang }[] = [];
  for (const actor of actors) {
    const asyncOperationType = actor.asyncOperationType ??
      "internalAsyncOperation";
    if (asyncOperationType !== "internalAsyncOperation") {
      logger.info(
        "Skipping actor {src}: asyncOperationType is {asyncOperationType}, not internalAsyncOperation",
        { src: actor.src, asyncOperationType },
      );
      continue;
    }
    const lang = actor.asyncOperationLanguage ?? "typescript";
    if (!isOperationLang(lang)) {
      logger.warning(
        "Skipping actor {src}: unsupported asyncOperationLanguage {lang}",
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
    selected.push({ actor, lang });
  }
  return selected;
}

/**
 * Re-derives the {@linkcode RegisteredActor}s a version folder's fsm.json
 * would resolve to, without writing anything — used to rebuild the
 * aggregate registry/worker SDK from every version under a plugin root (see
 * {@linkcode generateAsyncOperationLogicFromFsmJson}) without re-scaffolding
 * versions the caller isn't currently targeting.
 */
function deriveRegisteredActorsForVersion(
  absVersionFolderPath: string,
  fsmData: FsmMachineJson,
): RegisteredActor[] {
  return selectRegisterableActors(fsmData).map(({ actor, lang }) =>
    toRegisteredActor(absVersionFolderPath, lang, actor)
  );
}

/**
 * Writes actor files, the per-version `actors-manifest.json`, and each
 * language's per-version barrel/registry for one already-parsed fsm.json,
 * into `absVersionFolderPath`. Shared by
 * {@linkcode generateAsyncOperationLogicFromFolders} (one call per versioned
 * FSM folder it walks) and {@linkcode generateAsyncOperationLogicFromFsmJson}
 * (a single call for one fsm.json). Mutates `tsFiles`/`rustFiles` in place so
 * callers can batch-format everything written across a whole run.
 */
async function scaffoldAsyncLogicForVersion(
  absVersionFolderPath: string,
  fsmData: FsmMachineJson,
  tsFiles: string[],
  rustFiles: string[],
): Promise<RegisteredActor[]> {
  const selected = selectRegisterableActors(fsmData);

  const writtenActors: RegisteredActor[] = [];
  for (const { actor, lang } of selected) {
    const file = await writeActorFile(absVersionFolderPath, lang, actor);
    if (lang === "typescript") tsFiles.push(file);
    writtenActors.push(toRegisteredActor(absVersionFolderPath, lang, actor));
    logger.info("Wrote actor file {file}", { file });
  }

  logger.info("Wrote {count} actor file(s) in {path}", {
    count: writtenActors.length,
    path: absVersionFolderPath,
  });

  const manifestFile = await writeActorsManifest(
    absVersionFolderPath,
    writtenActors,
  );
  logger.info("Wrote actors manifest {file}", { file: manifestFile });

  for (const lang of BARREL_LANGS) {
    const barrelFile = await writeActorsBarrel(
      absVersionFolderPath,
      writtenActors,
      lang,
    );
    if (barrelFile) {
      if (lang === "typescript") tsFiles.push(barrelFile);
      logger.info("Wrote {lang} actors barrel {file}", {
        lang,
        file: barrelFile,
      });
    }

    const registryFile = await writeActorsRegistry(
      absVersionFolderPath,
      writtenActors,
      lang,
    );
    if (registryFile) {
      if (lang === "typescript") tsFiles.push(registryFile);
      if (lang === "rust") rustFiles.push(registryFile);
      logger.info("Wrote {lang} actors registry {file}", {
        lang,
        file: registryFile,
      });
    }
  }

  return writtenActors;
}

/**
 * Writes the once-per-app-root aggregate registry (TS/Python/Rust) and Go
 * registry, plus the worker SDK, from `allRegisteredActors` — the complete
 * set of actors across every version folder under `pluginRootAbsPath`, not
 * just whichever version(s) the caller scaffolded this run. Shared by
 * {@linkcode generateAsyncOperationLogicFromFolders} (which already has the
 * complete set, from the folders it just walked) and
 * {@linkcode generateAsyncOperationLogicFromFsmJson} (which re-derives it by
 * walking `pluginRootAbsPath` itself — see that function's doc comment).
 * Mutates `tsFiles`/`rustFiles`/`goFiles`/`goModDirs` in place so callers can
 * batch-format everything written across a whole run, aggregate step
 * included.
 */
async function writeAggregateArtifacts(
  pluginRootAbsPath: string,
  allRegisteredActors: RegisteredActor[],
  workerSdkProtocol: WorkerSdkProtocol,
  tsFiles: string[],
  rustFiles: string[],
  goFiles: string[],
  goModDirs: string[],
): Promise<void> {
  // One level above the plugin root (e.g. apps/fsm-core-example/fsm ->
  // apps/fsm-core-example) -- a sibling of every FSM name folder this run
  // processed, not nested inside any one of them.
  const pluginRootDirName = pluginRootAbsPath.split("/").at(-1)!;
  const appRootAbsPath = pluginRootAbsPath.split("/").slice(0, -1).join("/");

  for (const lang of BARREL_LANGS) {
    const aggregateFile = await writeAggregateActorsRegistry(
      appRootAbsPath,
      pluginRootDirName,
      allRegisteredActors,
      lang,
    );
    if (aggregateFile) {
      if (lang === "typescript") tsFiles.push(aggregateFile);
      if (lang === "rust") rustFiles.push(aggregateFile);
      logger.info("Wrote {lang} aggregate actors registry {file}", {
        lang,
        file: aggregateFile,
      });
    }
  }

  const goRegistryFile = await writeAggregateGoRegistry(
    appRootAbsPath,
    pluginRootDirName,
    allRegisteredActors,
  );
  if (goRegistryFile) {
    goFiles.push(goRegistryFile);
    goModDirs.push(goRegistryFile.slice(0, goRegistryFile.lastIndexOf("/")));
    logger.info("Wrote go aggregate actors registry {file}", {
      file: goRegistryFile,
    });
  }

  const wrote = await writeWorkerSdk(
    appRootAbsPath,
    pluginRootDirName,
    allRegisteredActors,
    { protocol: workerSdkProtocol },
  );
  tsFiles.push(...wrote.tsFiles);
  rustFiles.push(...wrote.rustFiles);
  goFiles.push(...wrote.goFiles);
  if (wrote.goModDir) goModDirs.push(wrote.goModDir);
  logger.info(
    "Wrote worker-sdk-generated/ (typescript={ts}, python={py}, rust={rust}, go={go})",
    { ts: wrote.typescript, py: wrote.python, rust: wrote.rust, go: wrote.go },
  );
}

/**
 * Scaffolds async operation logic (actors / invoke objects) for every versioned
 * FSM under `folderPath`.
 *
 * Each invoke object gets its **own file** at
 * `<lang>/actors/<asyncOperationType>_<asyncOperationVersion>_<src>.<ext>`,
 * where `<lang>` is the actor's `asyncOperationLanguage` (defaulting to
 * typescript). The file exports one function named after the actor `src`
 * (Go: exported/capitalized, plus its own `go.mod` — see
 * {@linkcode writeActorFile}). Invokes that resolve to the same
 * `<asyncOperationType>_<asyncOperationVersion>_<src>` within a language are
 * written once.
 *
 * Per version folder: `actors-manifest.json` (every actor across all
 * languages — `{ src, asyncOperationLanguage, filePath, exportedName }`), a per-language
 * barrel (`typescript/actors/index.ts`, `python/actors/__init__.py`,
 * `rust/actors/mod.rs`) re-exporting each actor by name, and a per-language
 * generated registry (`generated-registry.ts`/`generated_registry.py`/
 * `generated_registry.rs`) carrying each actor's full activity-registration
 * identity + handler — written only when at least one actor exists for that
 * language. Go has neither — see {@linkcode ActorsBarrelLang}'s doc comment.
 *
 * Once, at `<appRoot>/worker-sdk-generated/<lang>/` (alongside that
 * language's compiler-generated worker SDK — see {@linkcode writeWorkerSdk}):
 * a per-language **aggregate** registry
 * (`typescript-actors-registry.generated.ts`/
 * `python_actors_registry_generated.py`/`rust-actors-registry.generated.rs`/
 * `go-actors-registry-generated/`) combining every FSM-version's registry —
 * what a worker SDK build imports, since a single worker process serves its
 * language's actors across every FSM, not just one (see
 * {@linkcode writeAggregateActorsRegistry}, {@linkcode writeAggregateGoRegistry}).
 *
 * `workerSdkProtocol` selects which sidecar wire protocol the generated
 * worker SDKs speak — see {@linkcode WorkerSdkProtocol}. Defaults to
 * `"grpc"`.
 *
 * Every `write*` call below only writes — nothing is formatted/tidied
 * per-file as it's written. Instead, every `.ts`/`.rs`/`.go` path and Go
 * module directory produced across the *whole* run is collected and
 * formatted once at the very end (one `deno fmt`, one `rustfmt`, one
 * `gofmt`, one `go mod tidy` per Go module) — see
 * {@linkcode formatTsFilesBestEffort} and friends.
 */
export async function generateAsyncOperationLogicFromFolders(
  folderPath: string,
  skipDirs: string[] = [],
  workerSdkProtocol: WorkerSdkProtocol = "grpc",
): Promise<void> {
  logger.info("Scaffolding async operation logic from {path}", {
    path: folderPath,
  });

  const allRegisteredActors: RegisteredActor[] = [];
  const tsFiles: string[] = [];
  const rustFiles: string[] = [];
  const goFiles: string[] = [];
  const goModDirs: string[] = [];

  await eachVersionedFsmFolder(
    folderPath,
    skipDirs,
    async (absFolderPath, fsmData) => {
      const writtenActors = await scaffoldAsyncLogicForVersion(
        absFolderPath,
        fsmData,
        tsFiles,
        rustFiles,
      );
      allRegisteredActors.push(...writtenActors);
    },
  );

  const pluginRootAbsPath = resolvePluginRootAbsPath(folderPath);
  await writeAggregateArtifacts(
    pluginRootAbsPath,
    allRegisteredActors,
    workerSdkProtocol,
    tsFiles,
    rustFiles,
    goFiles,
    goModDirs,
  );

  await formatTsFilesBestEffort(tsFiles);
  await formatRustFilesBestEffort(rustFiles);
  await formatGoFilesBestEffort(goFiles);
  await goModTidyManyBestEffort(goModDirs);
}

/**
 * Scaffolds async operation logic for a single fsm.json file, for the CLI's
 * single-file `--folder` mode — used when the caller wants to target one
 * fsm.json directly instead of walking a plugin-root folder for every
 * versioned FSM under it. Writes actor files, the per-version
 * `actors-manifest.json`, and each language's per-version barrel/registry
 * into `absVersionFolderPath` (the CLI resolves it from `--output`,
 * independently of `fsmJsonPath`'s own location; it does not have to be
 * `fsmJsonPath`'s own containing directory).
 *
 * Also refreshes the once-per-app-root aggregate registry and worker SDK
 * (see {@linkcode writeAggregateArtifacts}), same as
 * {@linkcode generateAsyncOperationLogicFromFolders} — but since this run
 * only has this one fsm.json's actors in hand, it can't just pass those to
 * the aggregate writers (that would silently overwrite the aggregate with
 * only this file's actors, discarding every other FSM's entries). Instead it
 * derives the plugin root from `absVersionFolderPath`'s own
 * `<pluginRoot>/<fsmName>/<version>` nesting (the same layout
 * {@linkcode eachVersionedFsmFolder} walks — two levels up) and re-walks
 * every version folder under it, re-deriving each one's actors from its own
 * fsm.json (see {@linkcode deriveRegisteredActorsForVersion}; read-only,
 * nothing under those other version folders is rewritten) to reassemble the
 * complete set the aggregate step needs. `absVersionFolderPath` therefore
 * needs to actually sit inside a real plugin root for the aggregate refresh
 * to make sense — an arbitrary `--output` elsewhere still gets its own
 * files/manifest/barrel/registry written correctly, but the "plugin root"
 * two levels up from it won't be a real one.
 */
export async function generateAsyncOperationLogicFromFsmJson(
  fsmJsonPath: string,
  absVersionFolderPath: string,
  workerSdkProtocol: WorkerSdkProtocol = "grpc",
): Promise<void> {
  logger.info(
    "Scaffolding async operation logic from {path} into {versionFolder}",
    { path: fsmJsonPath, versionFolder: absVersionFolderPath },
  );

  const fsmData: FsmMachineJson = JSON.parse(
    await Deno.readTextFile(fsmJsonPath),
  );
  const tsFiles: string[] = [];
  const rustFiles: string[] = [];
  const goFiles: string[] = [];
  const goModDirs: string[] = [];

  await scaffoldAsyncLogicForVersion(
    absVersionFolderPath,
    fsmData,
    tsFiles,
    rustFiles,
  );

  // <pluginRoot>/<fsmName>/<version> -> <pluginRoot> is two levels up.
  const pluginRootAbsPath = absVersionFolderPath.split("/").slice(0, -2)
    .join("/");

  const allRegisteredActors: RegisteredActor[] = [];
  await eachVersionedFsmFolder(
    pluginRootAbsPath,
    [],
    async (versionFolderPath, versionFsmData) => {
      allRegisteredActors.push(
        ...deriveRegisteredActorsForVersion(versionFolderPath, versionFsmData),
      );
    },
  );

  await writeAggregateArtifacts(
    pluginRootAbsPath,
    allRegisteredActors,
    workerSdkProtocol,
    tsFiles,
    rustFiles,
    goFiles,
    goModDirs,
  );

  await formatTsFilesBestEffort(tsFiles);
  await formatRustFilesBestEffort(rustFiles);
  await formatGoFilesBestEffort(goFiles);
  await goModTidyManyBestEffort(goModDirs);
}
