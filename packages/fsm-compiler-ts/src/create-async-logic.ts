import { getLogger } from "@logtape/logtape";
import { isNotFoundError, isVersionFolderName } from "./util.ts";
import {
  ASYNC_WORKER_DIR_NAME,
  collectRegisteredActorsFromAsyncWorkerDir,
  formatGoFilesBestEffort,
  formatRustFilesBestEffort,
  formatTsFilesBestEffort,
  goModTidyManyBestEffort,
  relativeImportDir,
  toWrittenActor,
  writeActorFile,
  writeActorsBarrel,
  writeActorsManifest,
  writeAggregateActorsRegistry,
  writeAggregateGoRegistry,
} from "./operation-logic-scaffold.ts";
import { render as renderTsSharedAsyncOpRegistry } from "./scaffold-templates/eta/typescript/shared-async-op-registry.generated.ts";
import { render as renderPySharedAsyncOpRegistry } from "./scaffold-templates/eta/python/shared-async-op-registry.generated.ts";
import { render as renderRustSharedAsyncOpRegistry } from "./scaffold-templates/eta/rust/shared-async-op-registry.generated.ts";
import { render as renderGoActorsRegistryAggregate } from "./scaffold-templates/eta/go/actors-registry-aggregate.generated.ts";
import { render as renderGoModAggregate } from "./scaffold-templates/eta/go/go-mod-aggregate.generated.ts";
import type {
  ActorReference,
  ActorsBarrelLang,
  OperationLang,
  RegisteredActor,
} from "./types/index.ts";

const logger = getLogger(["@pgfsm/compiler", "create-async-logic"]);

/**
 * Directory name (relative to `<appRoot>/async-worker/<lang>/`) holding
 * actors that aren't scoped to any one FSM's `invoke` list — hand-created via
 * this command rather than scaffolded in bulk from `fsm.json` by
 * {@linkcode generateAsyncOperationLogicFromFolders}. Matches
 * {@linkcode SHARED_ASYNC_OP_PARENT_FSM_NAME} exactly (#330 — was the
 * hyphenated `"shared-async-op"` before; `generate-async-logic`'s aggregate
 * step derives its per-group import path from `parentFsmName` literally, so
 * a real directory name that didn't match it made that path always point at
 * a nonexistent directory whenever a shared-async-op actor got swept into
 * the FSM-scoped aggregate).
 */
const SHARED_ASYNC_OP_DIR_NAME = "sharedAsyncOperation";

/**
 * Fixed `parentFsmName`/`asyncOperationType` identity every shared-async-op
 * actor registers under — unlike FSM-scoped actors (whose `parentFsmName` is
 * the owning FSM and `asyncOperationType` is `"internalAsyncOperation"`,
 * derived from an invoke object), shared-async-op actors have no owning FSM,
 * so both are constants: `"sharedAsyncOperation"`, the same real
 * `InvokeObject["asyncOperationType"]` value a shared-queue invoke object
 * would carry.
 */
const SHARED_ASYNC_OP_FSM_TYPE = "sharedAsyncOperation" as const;
const SHARED_ASYNC_OP_PARENT_FSM_NAME = "sharedAsyncOperation";

/** Languages `create-async-logic` can also emit a `generated-registry.*` for — Go gets its own separate aggregate instead (see {@linkcode rewriteSharedAsyncOpGoRegistry}), since each Go actor is its own Go module and needs `require`/`replace` wiring, not a flat importable file. */
const REGISTRY_LANGS: ActorsBarrelLang[] = ["typescript", "python", "rust"];

/**
 * Per-language registry file name — matches `operation-logic-scaffold.ts`'s
 * own `ACTORS_REGISTRY_FILE_NAME` (not exported, so a deliberate separate
 * copy) rather than the hyphenated `generated-registry.<ext>` this command
 * used before #332 for every language. Required for Python specifically:
 * `generate-async-logic`'s FSM-scoped aggregate statically dot-imports each
 * group's registry (`from <group>.generated_registry import
 * ACTOR_REGISTRATIONS`), and Python has no way to dot-import a
 * hyphenated module name — once the real directory (#330) and this
 * per-version nesting (#332) both matched what that aggregate expects, the
 * hyphenated file name was the one thing left actually preventing a
 * shared-async-op actor swept into it from resolving (verified: `import
 * sharedAsyncOperation.v01.generated_registry` raised `ModuleNotFoundError`
 * until this file name changed to match). Rust keeps its own hyphenated name
 * unchanged — its FSM-scoped aggregate never reads a per-version registry
 * file at all (`#[path]`-includes the barrel directly), so nothing depends
 * on this file's exact name there.
 */
const SHARED_ASYNC_OP_REGISTRY_FILE_NAME: Record<ActorsBarrelLang, string> = {
  typescript: "generated-registry.ts",
  python: "generated_registry.py",
  rust: "generated-registry.rs",
};

/**
 * Directory name (relative to `<appRoot>/async-worker/go/sharedAsyncOperation/`)
 * holding the Go aggregate registry — same name/shape as
 * `writeAggregateGoRegistry`'s FSM-scoped equivalent
 * (`operation-logic-scaffold.ts`'s own `GO_AGGREGATE_DIR_NAME`, not exported,
 * so this is a deliberate separate copy of the literal, not a shared
 * constant).
 */
const GO_AGGREGATE_DIR_NAME = "go-actors-registry-generated";

function isRegistryLang(lang: OperationLang): lang is ActorsBarrelLang {
  return (REGISTRY_LANGS as OperationLang[]).includes(lang);
}

/**
 * One shared-async-op actor's entry in its `functionVersion`'s registry —
 * everything the per-language Eta template (`shared-async-op-registry.eta`)
 * needs to import the actor (aliased — retained even though each per-version
 * registry now only ever holds actors at that one version, #332, so a
 * same-version name collision is the only remaining risk — and it keeps the
 * alias format consistent with {@linkcode toSharedAsyncOpRegisteredActor}/
 * `rewriteSharedAsyncOpGoRegistry`) and register it.
 */
type SharedAsyncOpRegistryEntry = {
  src: string;
  alias: string;
  /**
   * The import target, already formatted for the target language, relative
   * to the per-version registry's own directory
   * (`sharedAsyncOperation/<functionVersion>/`, #332): a relative
   * `./`-prefixed module specifier for TypeScript, a dotted
   * absolute-from-that-directory module path for Python (via the `sys.path`
   * bootstrap in `shared-async-op-registry.eta`, computed from the
   * registry's own `__file__` so it's correct regardless of which version
   * directory it ends up in), or a bare relative file path (no leading
   * `./`) for Rust's `#[path]`.
   */
  importPath: string;
  parentFsmName: string;
  parentFsmVersion: string;
  asyncOperationType: typeof SHARED_ASYNC_OP_FSM_TYPE;
  asyncOperationName: string;
  asyncOperationVersion: string;
  asyncOperationLanguage: OperationLang;
};

/**
 * Sanitizes `<name>_<version>` into a safe TS/Python/Rust/Go identifier —
 * used as the import alias. Strictly needed only for `rewriteSharedAsyncOpGoRegistry`'s
 * still-global-across-every-version aggregate (#324), where two
 * `functionVersion`s of the same function name really can collide in the
 * same file; kept for `toSharedAsyncOpRegistryEntry`/
 * `toSharedAsyncOpRegisteredActor` too even though their own per-version
 * registry/manifest (#332/#322) can no longer have a same-file
 * cross-version collision, for a consistent alias format across every
 * shared-async-op artifact.
 */
function toRegistryAlias(fileBaseName: string, version: string): string {
  return `${fileBaseName}_${version}`.replace(/[^A-Za-z0-9]+/g, "_");
}

/**
 * Lists every `{ name, version }` pair already scaffolded under
 * `<asyncWorkerRoot>/<lang>/sharedAsyncOperation/<version>/actors/<name>/`, by
 * reading directories rather than a manifest, so the registry/manifest it
 * feeds always matches what's actually on disk even if a file was
 * hand-removed. `version` comes from the outer version folder.
 *
 * Verifies the actor's own stub file (`<name>/<name>.<ext>`, same path
 * {@linkcode toWrittenActor} computes) actually exists before including a
 * `<name>/` directory — hand-removing an actor's file (and its
 * `actors-manifest.json`) without also removing the now-empty `<name>/`
 * directory used to leave a stale entry behind that the next
 * `create-async-logic` call would still rebuild a registry/manifest from,
 * importing a handler from a file that no longer exists (#324). Originally
 * reported for {@linkcode rewriteSharedAsyncOpRegistry}'s old single global
 * file (any *different* `functionVersion`'s rebuild would still pick up a
 * stale entry from any other version) — its per-version registry (#332)
 * narrows that specific blast radius to "another call at the *same*
 * `functionVersion`", but {@linkcode rewriteSharedAsyncOpGoRegistry}'s own
 * aggregate stays a single global file across every version, so the
 * original scenario remains fully live for Go.
 */
async function listExistingSharedAsyncOpActors(
  asyncWorkerRoot: string,
  lang: OperationLang,
): Promise<{ name: string; version: string }[]> {
  const sharedAsyncOpDir =
    `${asyncWorkerRoot}/${lang}/${SHARED_ASYNC_OP_DIR_NAME}`;
  const result: { name: string; version: string }[] = [];
  let versionEntries: Deno.DirEntry[];
  try {
    versionEntries = await Array.fromAsync(Deno.readDir(sharedAsyncOpDir));
  } catch (err) {
    if (isNotFoundError(err)) return result;
    throw err;
  }
  for (const versionEntry of versionEntries) {
    if (!versionEntry.isDirectory || !isVersionFolderName(versionEntry.name)) {
      continue;
    }
    const versionDir = `${sharedAsyncOpDir}/${versionEntry.name}`;
    try {
      for await (const nameEntry of Deno.readDir(`${versionDir}/actors`)) {
        if (!nameEntry.isDirectory) continue;
        const { filePath } = toWrittenActor(lang, { src: nameEntry.name });
        try {
          await Deno.stat(`${versionDir}/${filePath}`);
        } catch (err) {
          if (isNotFoundError(err)) continue;
          throw err;
        }
        result.push({ name: nameEntry.name, version: versionEntry.name });
      }
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  }
  return result.sort((a, b) =>
    a.name === b.name
      ? a.version.localeCompare(b.version)
      : a.name.localeCompare(b.name)
  );
}

/** Builds one actor's {@linkcode SharedAsyncOpRegistryEntry}, with the import path formatted for `lang`. */
function toSharedAsyncOpRegistryEntry(
  lang: ActorsBarrelLang,
  name: string,
  version: string,
): SharedAsyncOpRegistryEntry {
  const alias = toRegistryAlias(name, version);
  const ext = lang === "typescript" ? "ts" : lang === "rust" ? "rs" : "py";
  // actors/<name>/<name>.<ext>, relative to sharedAsyncOperation/<version>/
  // (the per-version registry's own directory, #332 — the registry is now
  // colocated one level inside the version it's scoped to, same relationship
  // generate-async-logic's own per-version registry has to its own actors/,
  // see #328).
  const relParts = ["actors", name, name];
  const importPath = lang === "typescript"
    ? `./${relParts.join("/")}.${ext}`
    : lang === "rust"
    ? `${relParts.join("/")}.${ext}`
    : relParts.join(".");
  return {
    src: name,
    alias,
    importPath,
    parentFsmName: SHARED_ASYNC_OP_PARENT_FSM_NAME,
    parentFsmVersion: version,
    asyncOperationType: SHARED_ASYNC_OP_FSM_TYPE,
    asyncOperationName: name,
    asyncOperationVersion: version,
    asyncOperationLanguage: lang,
  };
}

/**
 * Builds one actor's {@linkcode RegisteredActor} record for
 * `actors-manifest.json` — same fixed `sharedAsyncOperation`
 * identity as {@linkcode toSharedAsyncOpRegistryEntry}, but the
 * `WrittenActor` fields (`fileBaseName`/`filePath`/`exportedName`, with Go's
 * own capitalization) come from {@linkcode toWrittenActor} instead of being
 * recomputed here, so both stay derived from the one place that already
 * knows how {@linkcode writeActorFile} names things.
 */
function toSharedAsyncOpRegisteredActor(
  lang: OperationLang,
  name: string,
  version: string,
): RegisteredActor {
  return {
    ...toWrittenActor(lang, { src: name }),
    parentFsmName: SHARED_ASYNC_OP_PARENT_FSM_NAME,
    parentFsmVersion: version,
    asyncOperationType: SHARED_ASYNC_OP_FSM_TYPE,
    asyncOperationName: name,
    asyncOperationVersion: version,
  };
}

/** Renders the global registry's content for one language via its Eta template. */
function buildSharedAsyncOpRegistryContent(
  entries: SharedAsyncOpRegistryEntry[],
  lang: ActorsBarrelLang,
): string {
  switch (lang) {
    case "typescript":
      return renderTsSharedAsyncOpRegistry({ actors: entries });
    case "python":
      return renderPySharedAsyncOpRegistry({ actors: entries });
    case "rust":
      return renderRustSharedAsyncOpRegistry({ actors: entries });
  }
}

/**
 * Rewrites `<asyncWorkerRoot>/<lang>/sharedAsyncOperation/<functionVersion>/generated-registry.<ext>`
 * from every shared-async-op actor currently on disk for `lang` *at that one
 * `functionVersion`* — scoped the same way {@linkcode rewriteSharedAsyncOpManifest}
 * already scopes `actors-manifest.json` (#332; before, this was a single
 * **global** flat file across every version, at `sharedAsyncOperation/
 * generated-registry.<ext>` with no per-version nesting). Repeated
 * `create-async-logic` calls at the same `functionVersion` still accumulate
 * into that version's own file instead of clobbering each other; a
 * *different* `functionVersion` gets its own separate file, not merged with
 * any other version's.
 *
 * This now matches the layout `generate-async-logic`'s FSM-scoped aggregate
 * always expected (`<parentFsmName>/<parentFsmVersion>/generated-registry.<ext>`,
 * #328) — combined with #330 (the real directory renamed to match
 * `parentFsmName`), a shared-async-op actor swept into that aggregate (the
 * still-open, separate leak issue) now resolves instead of 404ing, for
 * `typescript`/`python`. (`rust`'s FSM-scoped aggregate never reads this
 * per-version file at all — see `writeAggregateActorsRegistry`'s own doc
 * comment — so this doesn't change anything for Rust beyond the file's
 * location.)
 */
async function rewriteSharedAsyncOpRegistry(
  asyncWorkerRoot: string,
  lang: OperationLang,
  functionVersion: string,
): Promise<string | undefined> {
  if (!isRegistryLang(lang)) return undefined;
  const existing = await listExistingSharedAsyncOpActors(asyncWorkerRoot, lang);
  const entries = existing
    .filter(({ version }) => version === functionVersion)
    .map(({ name, version }) =>
      toSharedAsyncOpRegistryEntry(lang, name, version)
    );
  const dir =
    `${asyncWorkerRoot}/${lang}/${SHARED_ASYNC_OP_DIR_NAME}/${functionVersion}`;
  await Deno.mkdir(dir, { recursive: true });
  const file = `${dir}/${SHARED_ASYNC_OP_REGISTRY_FILE_NAME[lang]}`;
  await Deno.writeTextFile(
    file,
    buildSharedAsyncOpRegistryContent(entries, lang),
  );
  return file;
}

/**
 * Rewrites `<asyncWorkerRoot>/<lang>/sharedAsyncOperation/<functionVersion>/actors-manifest.json`
 * from every shared-async-op actor currently on disk for `lang` *at that one
 * `functionVersion`* (unlike {@linkcode rewriteSharedAsyncOpRegistry}'s
 * single global file across every version, since this manifest lives inside
 * the version folder itself — mirrors `generate-async-logic`'s own
 * per-`<fsmName>/<fsmVersion>` manifest, one level down). Written for every
 * language, not just {@linkcode REGISTRY_LANGS} — Go actors get a manifest
 * too, same as `generate-async-logic`'s own per-language manifests (#320).
 */
async function rewriteSharedAsyncOpManifest(
  asyncWorkerRoot: string,
  lang: OperationLang,
  functionVersion: string,
): Promise<string> {
  const existing = await listExistingSharedAsyncOpActors(asyncWorkerRoot, lang);
  const actors = existing
    .filter(({ version }) => version === functionVersion)
    .map(({ name, version }) =>
      toSharedAsyncOpRegisteredActor(lang, name, version)
    );
  const dir =
    `${asyncWorkerRoot}/${lang}/${SHARED_ASYNC_OP_DIR_NAME}/${functionVersion}`;
  return await writeActorsManifest(dir, actors);
}

/**
 * Rewrites `<asyncWorkerRoot>/<lang>/sharedAsyncOperation/<functionVersion>/actors/<barrel filename>`
 * (`index.ts`/`__init__.py`/`mod.rs`) from every shared-async-op actor
 * currently on disk for `lang` *at that one `functionVersion`* — same
 * "rebuild from whatever's on disk" + per-version scoping as
 * {@linkcode rewriteSharedAsyncOpManifest}/{@linkcode rewriteSharedAsyncOpRegistry}.
 * `create-async-logic` never wrote this before #334 — `generate-async-logic`
 * always has (its own `scaffoldAsyncLogicForVersion` calls
 * {@linkcode writeActorsBarrel} for every {@linkcode ActorsBarrelLang}
 * unconditionally, regardless of whether that language's own FSM-scoped
 * aggregate happens to consume the barrel), so this closes a structural gap
 * relative to that, not just a Rust-specific one.
 *
 * The concrete breakage this fixes: `generate-async-logic`'s FSM-scoped
 * Rust aggregate reaches every group's actors through its barrel
 * specifically (`#[path = "<parentFsmName>/<parentFsmVersion>/actors/mod.rs"]`
 * — Rust can't concatenate incompatible generated `ActorRegistration` types
 * across per-version registry files the way TS/Python's aggregates can, see
 * {@linkcode writeAggregateActorsRegistry}'s own doc comment). A
 * shared-async-op actor swept into that aggregate (the still-open,
 * separate collector-exclusion issue) had no barrel to `#[path]`-include —
 * even after #330/#332 closed the directory/file-name/nesting mismatches
 * for the *registry* file, Rust's aggregate was still broken (confirmed via
 * `cargo check`: `couldn't read .../sharedAsyncOperation/<version>/actors/mod.rs`).
 * `create-async-logic`'s own Rust registry (`shared-async-op-registry.eta`)
 * doesn't read this barrel at all — it `#[path]`-includes each actor file
 * directly — so this was never needed for `create-async-logic`'s own output
 * to work; only for a shared-async-op actor to be reachable from the
 * *other* (FSM-scoped) aggregate.
 */
async function rewriteSharedAsyncOpBarrel(
  asyncWorkerRoot: string,
  lang: OperationLang,
  functionVersion: string,
): Promise<string | undefined> {
  if (!isRegistryLang(lang)) return undefined;
  const existing = await listExistingSharedAsyncOpActors(asyncWorkerRoot, lang);
  const actors = existing
    .filter(({ version }) => version === functionVersion)
    .map(({ name, version }) =>
      toSharedAsyncOpRegisteredActor(lang, name, version)
    );
  return await writeActorsBarrel(
    asyncWorkerRoot,
    actors,
    lang,
    `${SHARED_ASYNC_OP_DIR_NAME}/${functionVersion}`,
  );
}

/**
 * Go's own aggregate for the shared-async-op pool, at
 * `<asyncWorkerRoot>/go/sharedAsyncOperation/go-actors-registry-generated/`
 * (`go.mod` + `registry.go`) — mirrors `writeAggregateGoRegistry`'s
 * FSM-scoped approach (one `require`+`replace` per actor's own standalone
 * Go module, since Go has no dynamic-loading equivalent to TS/Python's
 * `import()`/`importlib`), rebuilt from every Go shared-async-op actor
 * currently on disk (the one just written by
 * {@linkcode createAsyncOperationLogic} included), same idempotent-rebuild
 * approach as {@linkcode rewriteSharedAsyncOpRegistry}.
 *
 * Deliberately **not** a reuse of `writeAggregateGoRegistry` itself, even
 * though {@linkcode SHARED_ASYNC_OP_DIR_NAME} now matches `parentFsmName`
 * exactly (#330 — it didn't before, which independently made that reuse
 * compute a broken `replace` target; fixed now, but not the reason this
 * stays separate). `writeAggregateGoRegistry` writes into
 * `<writeRootAbsPath>/async-worker/go/go-actors-registry-generated/`, a
 * *single* aggregate for the whole async-worker tree that `generate-async-logic`
 * rebuilds from every actor it finds (FSM-scoped and, per the still-open
 * aggregate-leak issue, shared-async-op actors too). This function instead
 * writes a self-contained aggregate nested *inside*
 * `sharedAsyncOperation/`, scoped to only the shared-async-op pool and
 * rebuildable by `create-async-logic` alone — a project that only ever
 * calls `create-async-logic` (never `generate-async-logic`) still gets a
 * working Go aggregate for its shared actors.
 *
 * Returns `undefined` (writes nothing) when there are no Go shared-async-op
 * actors, matching `writeAggregateGoRegistry`'s own empty-set behavior.
 */
async function rewriteSharedAsyncOpGoRegistry(
  asyncWorkerRoot: string,
  goModuleAppRoot: string,
): Promise<{ registryFile: string; goModDir: string } | undefined> {
  const existing = await listExistingSharedAsyncOpActors(asyncWorkerRoot, "go");
  if (existing.length === 0) return undefined;

  const dir =
    `${asyncWorkerRoot}/go/${SHARED_ASYNC_OP_DIR_NAME}/${GO_AGGREGATE_DIR_NAME}`;
  await Deno.mkdir(dir, { recursive: true });

  const withMeta = existing.map(({ name, version }) => {
    const registered = toSharedAsyncOpRegisteredActor("go", name, version);
    // Matches goActorModulePath's own convention (operation-logic-scaffold.ts)
    // for the individual actor's own go.mod, written via writeActorFile ->
    // writeGoActorModule when lang === "go" -- it unconditionally lowercases
    // the fsmName segment (Go module paths disallow uppercase), so this
    // require+replace's left-hand module path must too, or it won't match
    // that go.mod's own declared `module` line.
    const modulePath =
      `${goModuleAppRoot}/${SHARED_ASYNC_OP_DIR_NAME.toLowerCase()}/${version}/go/actors/${name.toLowerCase()}`;
    const actorDir =
      `${asyncWorkerRoot}/go/${SHARED_ASYNC_OP_DIR_NAME}/${version}/actors/${name}`;
    return {
      ...registered,
      modulePath,
      alias: toRegistryAlias(name, version),
      actorDir,
    };
  });

  const goModContent = renderGoModAggregate({
    moduleName:
      `${goModuleAppRoot}/${SHARED_ASYNC_OP_DIR_NAME.toLowerCase()}/${GO_AGGREGATE_DIR_NAME}`,
    requires: withMeta.map((a) => ({ modulePath: a.modulePath })),
    replaces: withMeta.map((a) => ({
      modulePath: a.modulePath,
      target: relativeImportDir(dir, a.actorDir),
    })),
  });
  await Deno.writeTextFile(`${dir}/go.mod`, goModContent);

  const registryContent = renderGoActorsRegistryAggregate({
    imports: withMeta.map((a) => ({
      alias: a.alias,
      modulePath: a.modulePath,
    })),
    actors: withMeta,
  });
  const registryFile = `${dir}/registry.go`;
  await Deno.writeTextFile(registryFile, registryContent);

  return { registryFile, goModDir: dir };
}

/**
 * Scaffolds a single new actor stub in the shared, non-FSM-scoped async
 * operation pool at
 * `{cwd}/async-worker/<lang>/sharedAsyncOperation/<functionVersion>/actors/<functionName>/<functionName>.<ext>`,
 * via the same {@linkcode writeActorFile} helper
 * `generateAsyncOperationLogicFromFolders` uses per invoke object — so stub
 * content/formatting matches the rest of the actor-scaffolding pipeline.
 * Always anchored at `writeRootAbsPath` (the CLI passes `Deno.cwd()`), like
 * `generate-sync-logic`/`generate-async-logic` (#305/#307) — there's no
 * `--folder` input at all, since these actors have no owning FSM tree to walk
 * in the first place.
 *
 * Also writes/rewrites the following, all derived from whatever's actually
 * on disk (not just this one call's own actor), so repeated calls accumulate
 * instead of clobbering each other:
 * - `{cwd}/async-worker/<lang>/sharedAsyncOperation/<functionVersion>/actors-manifest.json`
 *   — every actor at *this* `functionVersion`, for every language (see
 *   {@linkcode rewriteSharedAsyncOpManifest}).
 * - For `typescript`/`python`/`rust` (see {@linkcode ActorsBarrelLang}), that
 *   language's actors barrel (`index.ts`/`__init__.py`/`mod.rs`) at *this*
 *   `functionVersion`'s own directory,
 *   `{cwd}/async-worker/<lang>/sharedAsyncOperation/<functionVersion>/actors/<barrel file>`
 *   (#334 — `generate-async-logic` has always written this for every FSM-scoped
 *   actor group; this pool never did, which left its Rust actors unreachable
 *   from the FSM-scoped aggregate's barrel-based `#[path]` include once swept
 *   into it — see {@linkcode rewriteSharedAsyncOpBarrel}).
 * - For `typescript`/`python`/`rust` (see {@linkcode ActorsBarrelLang}),
 *   that language's `generated-registry.*` at *this*
 *   `functionVersion`'s own directory,
 *   `{cwd}/async-worker/<lang>/sharedAsyncOperation/<functionVersion>/generated-registry.*`
 *   (#332 — scoped per-`functionVersion`, mirroring the manifest above, not a
 *   single global file across every version like before; see
 *   {@linkcode rewriteSharedAsyncOpRegistry}).
 * - For `go` only, its own aggregate at
 *   `{cwd}/async-worker/go/sharedAsyncOperation/go-actors-registry-generated/`
 *   (`go.mod` + `registry.go`, one `require`+`replace` per actor's own
 *   standalone Go module — see {@linkcode rewriteSharedAsyncOpGoRegistry}).
 * - The FSM-scoped aggregate for `lang` too (#336) —
 *   `typescript-actors-registry.generated.ts`/`python_actors_registry_generated.py`/
 *   `rust-actors-registry.generated.rs` at
 *   `{cwd}/async-worker/<lang>/`, or Go's own
 *   `{cwd}/async-worker/go/go-actors-registry-generated/`, via the same
 *   {@linkcode collectRegisteredActorsFromAsyncWorkerDir} +
 *   {@linkcode writeAggregateActorsRegistry}/{@linkcode writeAggregateGoRegistry}
 *   helpers `generate-async-operation-logic.ts` uses — so a shared-async-op
 *   actor is reachable from the FSM-scoped aggregate immediately, without a
 *   separate `generate-async-logic` run. `collectRegisteredActorsFromAsyncWorkerDir`
 *   already picks up this pool's own `actors-manifest.json` (written above,
 *   since #322), so no separate collection logic is needed here. The worker
 *   SDK (`run-async-worker.ts`/`run_async_worker.py`/etc, written by
 *   `writeWorkerSdk`) is NOT refreshed here: a worker still needs one
 *   `generate-async-logic`/`generate-all` run. (Originally because
 *   `writeWorkerSdk` needed the real FSM source tree, which this command
 *   doesn't have; since #370 it doesn't.)
 *
 * Every entry's identity is fixed to `parentFsmName`/`asyncOperationType`
 * `"sharedAsyncOperation"` since these actors have no owning FSM. Returns the
 * actor file's absolute path.
 */
export async function createAsyncOperationLogic(
  writeRootAbsPath: string,
  lang: OperationLang,
  functionVersion: string,
  functionName: string,
): Promise<string> {
  if (!isVersionFolderName(functionVersion)) {
    throw new Error(
      `Invalid version: ${functionVersion}. Must match the "v\\d{2}" folder-name convention (e.g. "v01").`,
    );
  }

  const asyncWorkerRoot = `${writeRootAbsPath}/${ASYNC_WORKER_DIR_NAME}`;
  const actor: ActorReference = {
    src: functionName,
    asyncOperationLanguage: lang,
  };

  const appRootDirName = writeRootAbsPath.split("/").at(-1)!;
  const file = await writeActorFile(
    asyncWorkerRoot,
    lang,
    actor,
    appRootDirName,
    `${SHARED_ASYNC_OP_DIR_NAME}/${functionVersion}`,
  );
  logger.info("Wrote actor file {file}", { file });

  const manifestFile = await rewriteSharedAsyncOpManifest(
    asyncWorkerRoot,
    lang,
    functionVersion,
  );
  logger.info("Wrote actors manifest {file}", { file: manifestFile });

  const barrelFile = await rewriteSharedAsyncOpBarrel(
    asyncWorkerRoot,
    lang,
    functionVersion,
  );
  if (barrelFile) {
    logger.info("Wrote actors barrel {file}", { file: barrelFile });
  }

  const registryFile = await rewriteSharedAsyncOpRegistry(
    asyncWorkerRoot,
    lang,
    functionVersion,
  );
  if (registryFile) {
    logger.info("Wrote actors registry {file}", { file: registryFile });
  }

  const goRegistry = lang === "go"
    ? await rewriteSharedAsyncOpGoRegistry(asyncWorkerRoot, appRootDirName)
    : undefined;
  if (goRegistry) {
    logger.info("Wrote actors registry {file}", {
      file: goRegistry.registryFile,
    });
  }

  // Refreshes the FSM-scoped aggregate for `lang` too (#336) -- rebuilt from
  // every RegisteredActor on disk under writeRootAbsPath (this pool's own
  // actors-manifest.json included, since #322), same as
  // generate-async-operation-logic.ts's own writeAggregateArtifacts step.
  const allRegisteredActors = await collectRegisteredActorsFromAsyncWorkerDir(
    writeRootAbsPath,
  );
  const aggregateFile = isRegistryLang(lang)
    ? await writeAggregateActorsRegistry(
      writeRootAbsPath,
      allRegisteredActors,
      lang,
    )
    : undefined;
  const fsmScopedGoRegistryFile = lang === "go"
    ? await writeAggregateGoRegistry(
      writeRootAbsPath,
      appRootDirName,
      allRegisteredActors,
    )
    : undefined;
  if (aggregateFile) {
    logger.info("Wrote FSM-scoped aggregate registry {file}", {
      file: aggregateFile,
    });
  }
  if (fsmScopedGoRegistryFile) {
    logger.info("Wrote FSM-scoped aggregate registry {file}", {
      file: fsmScopedGoRegistryFile,
    });
  }

  // One batched format call instead of per-file — see
  // generate-async-operation-logic.ts's doc comment for the same rationale
  // (only ever a handful of files here, but keeps both scaffolding paths
  // consistent). actors-manifest.json is pre-formatted JSON, not
  // deno-fmt/rustfmt content -- same reasoning
  // generate-async-operation-logic.ts's own manifest write follows -- so it's
  // excluded from both batches. Python has no formatter here (matching
  // generate-async-operation-logic.ts's own lack of one), so barrelFile is
  // only batched for typescript/rust.
  const tsFiles = [file, barrelFile, registryFile, aggregateFile].filter(
    (f): f is string => f !== undefined && lang === "typescript",
  );
  const rustFiles = [barrelFile, registryFile, aggregateFile].filter(
    (f): f is string => f !== undefined && lang === "rust",
  );
  await formatTsFilesBestEffort(tsFiles);
  await formatRustFilesBestEffort(rustFiles);
  const goFilesToFormat = [
    goRegistry?.registryFile,
    fsmScopedGoRegistryFile,
  ].filter((f): f is string => f !== undefined);
  if (goFilesToFormat.length > 0) {
    await formatGoFilesBestEffort(goFilesToFormat);
  }
  const goModDirsToTidy = [
    goRegistry?.goModDir,
    fsmScopedGoRegistryFile
      ? fsmScopedGoRegistryFile.slice(
        0,
        fsmScopedGoRegistryFile.lastIndexOf("/"),
      )
      : undefined,
  ].filter((d): d is string => d !== undefined);
  if (goModDirsToTidy.length > 0) {
    await goModTidyManyBestEffort(goModDirsToTidy);
  }

  return file;
}
