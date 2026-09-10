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
 * Writes the aggregate registry (TS/Python/Rust) and Go registry, plus the
 * worker SDK, from `allRegisteredActors` — the complete set of actors across
 * every version folder in the real FSM tree, not just whichever version(s)
 * the caller scaffolded this run. Everything gets written directly under
 * `writeRootAbsPath` (`<writeRootAbsPath>/worker-sdk-generated/...`), which
 * is a pure write destination — it does not need to itself be, or contain,
 * any FSM (that's why `--plugin-root` is a required CLI argument rather than
 * derived/guessed, but callers are responsible for deriving
 * `allRegisteredActors`/`goModuleAppRoot`/`realPluginRootAbsPath` from the
 * *real* tree, not from `writeRootAbsPath`). `realPluginRootAbsPath` is that
 * real tree — used to compute a genuine relative path from wherever each
 * file actually lands back to the real FSM version folders it needs to
 * reference, since `writeRootAbsPath` and the real tree can now be
 * arbitrarily far apart. Shared by
 * {@linkcode generateAsyncOperationLogicFromFolders} and
 * {@linkcode generateAsyncOperationLogicFromFsmJson}. Mutates
 * `tsFiles`/`rustFiles`/`goFiles`/`goModDirs` in place so callers can
 * batch-format everything written across a whole run, aggregate step
 * included.
 */
async function writeAggregateArtifacts(
  writeRootAbsPath: string,
  goModuleAppRoot: string,
  realPluginRootAbsPath: string,
  allRegisteredActors: RegisteredActor[],
  workerSdkProtocol: WorkerSdkProtocol,
  tsFiles: string[],
  rustFiles: string[],
  goFiles: string[],
  goModDirs: string[],
): Promise<void> {
  for (const lang of BARREL_LANGS) {
    const aggregateFile = await writeAggregateActorsRegistry(
      writeRootAbsPath,
      realPluginRootAbsPath,
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
    writeRootAbsPath,
    goModuleAppRoot,
    realPluginRootAbsPath,
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
    writeRootAbsPath,
    goModuleAppRoot,
    realPluginRootAbsPath,
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
 *
 * `writeRootAbsPath` (`--plugin-root`) is purely where `worker-sdk-generated/`
 * gets written — it defaults to `folderPath` itself (the conventional case,
 * matching today's on-disk layout) but can point anywhere, including a
 * directory with no FSMs in it at all. It has no bearing on which actors get
 * aggregated: that set always comes from `folderPath`'s own walk above (the
 * real FSM tree — `--folder` names it directly in this mode, unlike
 * {@linkcode generateAsyncOperationLogicFromFsmJson}'s single-file mode,
 * which has to re-derive it), same as it always has.
 */
export async function generateAsyncOperationLogicFromFolders(
  folderPath: string,
  skipDirs: string[] = [],
  workerSdkProtocol: WorkerSdkProtocol = "grpc",
  writeRootAbsPath: string = resolvePluginRootAbsPath(folderPath),
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

  const realPluginRootAbsPath = resolvePluginRootAbsPath(folderPath);
  // The *real* app-root directory name (e.g. "fsm-core-example") each
  // individual Go actor's own go.mod already names itself under (see
  // operation-logic-scaffold.ts's goActorModulePath) -- derived from
  // folderPath (the real FSM tree), independent of writeRootAbsPath.
  const goModuleAppRoot = realPluginRootAbsPath.split("/").at(-2)!;

  await writeAggregateArtifacts(
    writeRootAbsPath,
    goModuleAppRoot,
    realPluginRootAbsPath,
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
 * Also refreshes the aggregate registry and worker SDK (see
 * {@linkcode writeAggregateArtifacts}), same as
 * {@linkcode generateAsyncOperationLogicFromFolders} — but since this run
 * only has this one fsm.json's actors in hand, it can't just pass those to
 * the aggregate writers (that would silently overwrite the aggregate with
 * only this file's actors, discarding every other FSM's entries). Instead it
 * re-walks every version folder under the *real* plugin root, re-deriving
 * each one's actors from its own fsm.json (see
 * {@linkcode deriveRegisteredActorsForVersion}; read-only, nothing under
 * those other version folders is rewritten) to reassemble the complete set
 * the aggregate step needs.
 *
 * The real plugin root is derived from `fsmJsonPath`'s own location — not
 * from `absVersionFolderPath`/`--output` (which can point anywhere, e.g. a
 * scratch directory outside the real FSM tree) and not from
 * `writeRootAbsPath`/`--plugin-root` (a pure write destination — see
 * {@linkcode writeAggregateArtifacts}). `fsmJsonPath` is expected to sit at
 * the conventional `<realPluginRoot>/<fsmName>/<version>/fsm.json` depth
 * (the same layout {@linkcode eachVersionedFsmFolder} walks); passing one
 * that doesn't means the aggregate step walks the wrong tree (or nothing).
 *
 * `writeRootAbsPath` defaults to that real plugin root (writing
 * `worker-sdk-generated/` inside it, matching
 * {@linkcode generateAsyncOperationLogicFromFolders}'s own default), but can
 * point anywhere.
 */
export async function generateAsyncOperationLogicFromFsmJson(
  fsmJsonPath: string,
  absVersionFolderPath: string,
  workerSdkProtocol: WorkerSdkProtocol = "grpc",
  writeRootAbsPath?: string,
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

  // <realPluginRoot>/<fsmName>/<version>/fsm.json -> <realPluginRoot> is
  // three levels up from the file itself.
  const absFsmJsonPath = fsmJsonPath.startsWith("/")
    ? fsmJsonPath
    : `${Deno.cwd()}/${fsmJsonPath}`;
  const realPluginRootAbsPath = absFsmJsonPath.split("/").slice(0, -3)
    .join("/");
  const goModuleAppRoot = realPluginRootAbsPath.split("/").at(-2)!;

  const allRegisteredActors: RegisteredActor[] = [];
  await eachVersionedFsmFolder(
    realPluginRootAbsPath,
    [],
    async (versionFolderPath, versionFsmData) => {
      allRegisteredActors.push(
        ...deriveRegisteredActorsForVersion(versionFolderPath, versionFsmData),
      );
    },
  );

  await writeAggregateArtifacts(
    writeRootAbsPath ?? realPluginRootAbsPath,
    goModuleAppRoot,
    realPluginRootAbsPath,
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
