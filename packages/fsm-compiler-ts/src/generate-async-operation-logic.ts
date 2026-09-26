import { getLogger } from "@logtape/logtape";
import { table } from "@pgfsm/logging";
import { extractFsmPluginRefs } from "./util.ts";
import {
  actorFileBaseName,
  ASYNC_WORKER_DIR_NAME,
  collectRegisteredActorsFromAsyncWorkerDir,
  eachVersionedFsmFolder,
  formatGoFilesBestEffort,
  formatRustFilesBestEffort,
  formatTsFilesBestEffort,
  fsmIdentityFromVersionFolderPath,
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
 * own. Pure (no I/O) — used when actually writing a version's files (see
 * {@linkcode scaffoldAsyncLogicForVersion}).
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
 * Writes actor files, each language's `actors-manifest.json`, and each
 * language's barrel/registry for one already-parsed fsm.json, into
 * `<writeRootAbsPath>/async-worker/<lang>/<fsmName>/<fsmVersion>/` — always
 * anchored at `writeRootAbsPath` (the CLI passes `Deno.cwd()` for the
 * standalone command, or its own `writeRootAbsPath` convention when called
 * from `generate-all`), never at the source FSM tree's own location. Shared
 * by {@linkcode generateAsyncOperationLogicFromFolders} (one call per
 * versioned FSM folder it walks, `fsmName`/`fsmVersion` derived from that
 * folder's own path) and {@linkcode generateAsyncOperationLogicFromFsmJson}
 * (a single call for one fsm.json, `fsmName`/`fsmVersion` caller-supplied
 * since single-file mode has no `<fsmName>/<fsmVersion>/fsm.json` folder
 * structure to infer them from). `goModuleAppRoot` is passed through to
 * {@linkcode writeActorFile} as its Go `appRootOverride`, since the write
 * location no longer sits at the conventional
 * `<appRoot>/<pluginRoot>/<fsmName>/<version>` depth
 * {@linkcode goActorModulePath}'s own default derivation assumes. Mutates
 * `tsFiles`/`rustFiles` in place so callers can batch-format everything
 * written across a whole run.
 */
async function scaffoldAsyncLogicForVersion(
  writeRootAbsPath: string,
  fsmName: string,
  fsmVersion: string,
  goModuleAppRoot: string,
  fsmData: FsmMachineJson,
  tsFiles: string[],
  rustFiles: string[],
): Promise<RegisteredActor[]> {
  const selected = selectRegisterableActors(fsmData);
  const asyncWorkerRoot = `${writeRootAbsPath}/${ASYNC_WORKER_DIR_NAME}`;
  const subPath = `${fsmName}/${fsmVersion}`;
  const perVersionLangDir = (lang: OperationLang) =>
    `${asyncWorkerRoot}/${lang}/${subPath}`;

  const writtenActors: RegisteredActor[] = [];
  for (const { actor, lang } of selected) {
    const file = await writeActorFile(
      asyncWorkerRoot,
      lang,
      actor,
      goModuleAppRoot,
      subPath,
    );
    if (lang === "typescript") tsFiles.push(file);
    writtenActors.push(
      toRegisteredActor(perVersionLangDir(lang), lang, actor),
    );
  }

  // table() drives the TTY console.table; one row per actor beats a
  // "Wrote actor file X" line per iteration once there's more than a
  // handful.
  logger.info("Wrote {count} actor file(s) for {fsmName}/{fsmVersion}:", {
    count: writtenActors.length,
    fsmName,
    fsmVersion,
    ...table(writtenActors, ["src", "asyncOperationLanguage", "filePath"]),
  });

  // One actors-manifest.json per language actually used this version (not
  // every SUPPORTED_OPERATION_LANGS member) -- unlike the old single
  // combined manifest, an empty per-language manifest for a language this
  // FSM doesn't use would just be directory clutter.
  const langsUsed = [...new Set(selected.map((s) => s.lang))];
  const manifestRows: { lang: OperationLang; file: string }[] = [];
  for (const lang of langsUsed) {
    const langActors = writtenActors.filter((a) =>
      a.asyncOperationLanguage === lang
    );
    const manifestFile = await writeActorsManifest(
      perVersionLangDir(lang),
      langActors,
    );
    manifestRows.push({ lang, file: manifestFile });
  }
  if (manifestRows.length > 0) {
    logger.info("Wrote {count} actors manifest(s):", {
      count: manifestRows.length,
      ...table(manifestRows, ["lang", "file"]),
    });
  }

  const barrelRows: {
    lang: ActorsBarrelLang;
    barrelFile?: string;
    registryFile?: string;
  }[] = [];
  for (const lang of BARREL_LANGS) {
    const barrelFile = await writeActorsBarrel(
      asyncWorkerRoot,
      writtenActors,
      lang,
      subPath,
    );
    if (barrelFile && lang === "typescript") tsFiles.push(barrelFile);

    const registryFile = await writeActorsRegistry(
      asyncWorkerRoot,
      writtenActors,
      lang,
      subPath,
    );
    if (registryFile) {
      if (lang === "typescript") tsFiles.push(registryFile);
      if (lang === "rust") rustFiles.push(registryFile);
    }

    if (barrelFile || registryFile) {
      barrelRows.push({ lang, barrelFile, registryFile });
    }
  }
  if (barrelRows.length > 0) {
    logger.info(
      "Wrote {count} per-language barrel/registry file(s) for {fsmName}/{fsmVersion}:",
      {
        count: barrelRows.length,
        fsmName,
        fsmVersion,
        ...table(barrelRows, ["lang", "barrelFile", "registryFile"]),
      },
    );
  }

  return writtenActors;
}

/**
 * Writes the aggregate registry (TS/Python/Rust) and Go registry, plus the
 * worker SDK, from every {@linkcode RegisteredActor} actually on disk under
 * `<writeRootAbsPath>/async-worker/` — not just whichever version(s) the
 * caller scaffolded this run. Collected by {@linkcode
 * collectRegisteredActorsFromAsyncWorkerDir}, which reads every already-
 * written `actors-manifest.json` back (see its own doc comment for why this
 * replaced the old re-derive-from-the-source-FSM-tree approach: it silently
 * dropped actors scaffolded under a caller-supplied identity that doesn't
 * match its source `fsm.json`'s own folder path). Everything gets written
 * directly under `writeRootAbsPath` (`<writeRootAbsPath>/async-worker/...`),
 * alongside every `<fsmName>/<fsmVersion>/` {@linkcode
 * scaffoldAsyncLogicForVersion} wrote — both live under the same
 * `async-worker/<lang>/` tree by construction now (see {@linkcode
 * writeAggregateActorsRegistry}'s own doc comment). `realPluginRootAbsPath`
 * (the real FSM source tree) is only still needed for {@linkcode
 * writeWorkerSdk}'s `gatewaySidecarProtoGen*` targets, which point at
 * sibling monorepo packages relative to where the source tree sits, not to
 * `writeRootAbsPath`. Shared by
 * {@linkcode generateAsyncOperationLogicFromFolders} and
 * {@linkcode generateAsyncOperationLogicFromFsmJson} — both call this
 * *after* their own `scaffoldAsyncLogicForVersion` call(s) have already
 * written this run's actor files/manifests, so the scan below always sees
 * them. Mutates `tsFiles`/`rustFiles`/`goFiles`/`goModDirs` in place so
 * callers can batch-format everything written across a whole run, aggregate
 * step included.
 */
async function writeAggregateArtifacts(
  writeRootAbsPath: string,
  goModuleAppRoot: string,
  realPluginRootAbsPath: string,
  tsFiles: string[],
  rustFiles: string[],
  goFiles: string[],
  goModDirs: string[],
): Promise<void> {
  const allRegisteredActors = await collectRegisteredActorsFromAsyncWorkerDir(
    writeRootAbsPath,
  );
  logger.info(
    "Collected {count} registered actor(s) from {path}/{asyncWorkerDir}/ for the aggregate step:",
    {
      count: allRegisteredActors.length,
      path: writeRootAbsPath,
      asyncWorkerDir: ASYNC_WORKER_DIR_NAME,
    },
  );

  const aggregateRows: { lang: OperationLang; file: string }[] = [];
  for (const lang of BARREL_LANGS) {
    const aggregateFile = await writeAggregateActorsRegistry(
      writeRootAbsPath,
      allRegisteredActors,
      lang,
    );
    if (aggregateFile) {
      if (lang === "typescript") tsFiles.push(aggregateFile);
      if (lang === "rust") rustFiles.push(aggregateFile);
      aggregateRows.push({ lang, file: aggregateFile });
    }
  }

  const goRegistryFile = await writeAggregateGoRegistry(
    writeRootAbsPath,
    goModuleAppRoot,
    allRegisteredActors,
  );
  if (goRegistryFile) {
    goFiles.push(goRegistryFile);
    goModDirs.push(goRegistryFile.slice(0, goRegistryFile.lastIndexOf("/")));
    aggregateRows.push({ lang: "go", file: goRegistryFile });
  }

  if (aggregateRows.length > 0) {
    logger.info("Wrote {count} aggregate actors registry file(s):", {
      count: aggregateRows.length,
      ...table(aggregateRows, ["lang", "file"]),
    });
  }

  const wrote = await writeWorkerSdk(
    writeRootAbsPath,
    goModuleAppRoot,
    realPluginRootAbsPath,
    allRegisteredActors,
  );
  tsFiles.push(...wrote.tsFiles);
  rustFiles.push(...wrote.rustFiles);
  goFiles.push(...wrote.goFiles);
  if (wrote.goModDir) goModDirs.push(wrote.goModDir);
  logger.info("Wrote async-worker/ into {path}:", {
    path: writeRootAbsPath,
    ...table({
      typescript: wrote.typescript,
      python: wrote.python,
      rust: wrote.rust,
      go: wrote.go,
    }),
  });
}

/**
 * Scaffolds async operation logic (actors / invoke objects) for every versioned
 * FSM under `folderPath`, writing into
 * `<writeRootAbsPath>/async-worker/<lang>/<fsmName>/<fsmVersion>/` for each
 * one (the CLI passes `Deno.cwd()` for `writeRootAbsPath` — output is
 * anchored at wherever the command is invoked from, not at `folderPath`'s own
 * location). `fsmName`/`fsmVersion` are derived from each versioned FSM
 * folder's own path as {@linkcode eachVersionedFsmFolder} walks it.
 *
 * Each invoke object gets its **own file** at
 * `async-worker/<lang>/<fsmName>/<fsmVersion>/actors/<asyncOperationType>_<asyncOperationVersion>_<src>.<ext>`,
 * where `<lang>` is the actor's `asyncOperationLanguage` (defaulting to
 * typescript). The file exports one function named after the actor `src`
 * (Go: exported/capitalized, plus its own `go.mod` — see
 * {@linkcode writeActorFile}). Invokes that resolve to the same
 * `<asyncOperationType>_<asyncOperationVersion>_<src>` within a language are
 * written once.
 *
 * Per `<lang>/<fsmName>/<fsmVersion>/`: `actors-manifest.json` (that
 * language's actors — `{ src, asyncOperationLanguage, filePath, exportedName }`,
 * written only for languages this version actually used), a barrel
 * (`index.ts`/`__init__.py`/`mod.rs`, TS/Python/Rust only) re-exporting each
 * actor by name, and a generated registry (`generated-registry.ts`/
 * `generated_registry.py`/`generated_registry.rs`) carrying each actor's full
 * activity-registration identity + handler — written only when at least one
 * actor exists for that language. Go has neither barrel nor registry — see
 * {@linkcode ActorsBarrelLang}'s doc comment.
 *
 * Once, at `<writeRootAbsPath>/async-worker/<lang>/` (alongside that
 * language's compiler-generated worker SDK — see {@linkcode writeWorkerSdk}):
 * a per-language **aggregate** registry
 * (`typescript-actors-registry.generated.ts`/
 * `python_actors_registry_generated.py`/`rust-actors-registry.generated.rs`/
 * `go-actors-registry-generated/`) combining every FSM-version's registry —
 * what a worker SDK build imports, since a single worker process serves its
 * language's actors across every FSM, not just one (see
 * {@linkcode writeAggregateActorsRegistry}, {@linkcode writeAggregateGoRegistry}).
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
  writeRootAbsPath: string,
): Promise<void> {
  logger.info("Scaffolding async operation logic from {path}", {
    path: folderPath,
  });

  const realPluginRootAbsPath = resolvePluginRootAbsPath(folderPath);
  // The *real* app-root directory name (e.g. "fsm-core-example") each
  // individual Go actor's own go.mod already names itself under (see
  // operation-logic-scaffold.ts's goActorModulePath) -- derived from
  // folderPath (the real FSM tree), independent of writeRootAbsPath.
  const goModuleAppRoot = realPluginRootAbsPath.split("/").at(-2)!;

  const tsFiles: string[] = [];
  const rustFiles: string[] = [];
  const goFiles: string[] = [];
  const goModDirs: string[] = [];

  await eachVersionedFsmFolder(
    folderPath,
    skipDirs,
    async (absFolderPath, fsmData) => {
      const { fsmName, fsmVersion } = fsmIdentityFromVersionFolderPath(
        absFolderPath,
      );
      await scaffoldAsyncLogicForVersion(
        writeRootAbsPath,
        fsmName,
        fsmVersion,
        goModuleAppRoot,
        fsmData,
        tsFiles,
        rustFiles,
      );
    },
  );

  logger.info("Resolved paths for {path}:", {
    path: folderPath,
    ...table({ writeRootAbsPath, realPluginRootAbsPath, goModuleAppRoot }),
  });

  await writeAggregateArtifacts(
    writeRootAbsPath,
    goModuleAppRoot,
    realPluginRootAbsPath,
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
 * versioned FSM under it. Unlike folder mode, there's no
 * `<fsmName>/<fsmVersion>/fsm.json` directory structure to infer identity
 * from, so `fsmName`/`fsmVersion` are caller-supplied (the CLI requires
 * `--fsm-name`/`--fsm-version` for this mode, mirroring
 * `generate-sync-logic`/`validate-sync-operation`'s own single-file-mode
 * flags). Writes into
 * `<writeRootAbsPath>/async-worker/<lang>/<fsmName>/<fsmVersion>/` (the CLI
 * passes `Deno.cwd()` for `writeRootAbsPath`), independent of both
 * `fsmJsonPath`'s own location and `fsmName`/`fsmVersion`'s.
 *
 * Also refreshes the aggregate registry and worker SDK (see
 * {@linkcode writeAggregateArtifacts}), same as
 * {@linkcode generateAsyncOperationLogicFromFolders} — since that function
 * now rebuilds the complete actor set itself by reading every
 * `actors-manifest.json` already on disk under `writeRootAbsPath` (see
 * {@linkcode collectRegisteredActorsFromAsyncWorkerDir}), this run only
 * needs to have already scaffolded *this* fsm.json's own actors (above)
 * before calling it — no separate re-derivation of every other FSM's actors
 * is needed here.
 */
export async function generateAsyncOperationLogicFromFsmJson(
  fsmJsonPath: string,
  writeRootAbsPath: string,
  fsmName: string,
  fsmVersion: string,
): Promise<void> {
  logger.info(
    "Scaffolding async operation logic from {path} into {writeRootAbsPath}",
    { path: fsmJsonPath, writeRootAbsPath },
  );

  const fsmData: FsmMachineJson = JSON.parse(
    await Deno.readTextFile(fsmJsonPath),
  );
  const tsFiles: string[] = [];
  const rustFiles: string[] = [];
  const goFiles: string[] = [];
  const goModDirs: string[] = [];

  // <realPluginRoot>/<fsmName>/<version>/fsm.json -> <realPluginRoot> is
  // three levels up from the file itself.
  const absFsmJsonPath = fsmJsonPath.startsWith("/")
    ? fsmJsonPath
    : `${Deno.cwd()}/${fsmJsonPath}`;
  const realPluginRootAbsPath = absFsmJsonPath.split("/").slice(0, -3)
    .join("/");
  const goModuleAppRoot = realPluginRootAbsPath.split("/").at(-2)!;

  await scaffoldAsyncLogicForVersion(
    writeRootAbsPath,
    fsmName,
    fsmVersion,
    goModuleAppRoot,
    fsmData,
    tsFiles,
    rustFiles,
  );

  logger.info(
    "Scaffolded async operation logic for {fsmName}/{fsmVersion}",
    { fsmName, fsmVersion },
  );

  await writeAggregateArtifacts(
    writeRootAbsPath,
    goModuleAppRoot,
    realPluginRootAbsPath,
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
