import { getLogger } from "@logtape/logtape";
import { isNotFoundError, isVersionFolderName } from "./util.ts";
import {
  ASYNC_WORKER_DIR_NAME,
  formatRustFilesBestEffort,
  formatTsFilesBestEffort,
  toWrittenActor,
  writeActorFile,
  writeActorsManifest,
} from "./operation-logic-scaffold.ts";
import { render as renderTsSharedAsyncOpRegistry } from "./scaffold-templates/eta/typescript/shared-async-op-registry.generated.ts";
import { render as renderPySharedAsyncOpRegistry } from "./scaffold-templates/eta/python/shared-async-op-registry.generated.ts";
import { render as renderRustSharedAsyncOpRegistry } from "./scaffold-templates/eta/rust/shared-async-op-registry.generated.ts";
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
 * {@linkcode generateAsyncOperationLogicFromFolders}.
 */
const SHARED_ASYNC_OP_DIR_NAME = "shared-async-op";

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

/** Languages `create-async-logic` can also emit a `generated-registry.*` for — Go has no registry (each Go actor is already its own Go module, see its own `go.mod`). */
const REGISTRY_LANGS: ActorsBarrelLang[] = ["typescript", "python", "rust"];

function isRegistryLang(lang: OperationLang): lang is ActorsBarrelLang {
  return (REGISTRY_LANGS as OperationLang[]).includes(lang);
}

/**
 * One shared-async-op actor's entry in the global registry — everything the
 * per-language Eta template (`shared-async-op-registry.eta`) needs to import
 * the actor (aliased, since the same function name can recur across
 * different `functionVersion`s and would otherwise collide) and register it.
 */
type SharedAsyncOpRegistryEntry = {
  src: string;
  alias: string;
  /**
   * The import target, already formatted for the target language:
   * a relative `./`-prefixed module specifier for TypeScript, a dotted
   * absolute-from-`shared-async-op/` module path for Python, or a bare
   * relative file path (no leading `./`) for Rust's `#[path]`.
   */
  importPath: string;
  parentFsmName: string;
  parentFsmVersion: string;
  asyncOperationType: typeof SHARED_ASYNC_OP_FSM_TYPE;
  asyncOperationName: string;
  asyncOperationVersion: string;
  asyncOperationLanguage: OperationLang;
};

/** Sanitizes `<name>_<version>` into a safe TS/Python/Rust identifier — used as the import alias so two function-versions of the same function name never collide in the same registry file. */
function toRegistryAlias(fileBaseName: string, version: string): string {
  return `${fileBaseName}_${version}`.replace(/[^A-Za-z0-9]+/g, "_");
}

/**
 * Lists every `{ name, version }` pair already scaffolded under
 * `<asyncWorkerRoot>/<lang>/shared-async-op/<version>/actors/<name>/`, by
 * reading directories rather than a manifest, so the registry/manifest it
 * feeds always matches what's actually on disk even if a file was
 * hand-removed. `version` comes from the outer version folder.
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
    const actorsDir = `${sharedAsyncOpDir}/${versionEntry.name}/actors`;
    try {
      for await (const nameEntry of Deno.readDir(actorsDir)) {
        if (nameEntry.isDirectory) {
          result.push({ name: nameEntry.name, version: versionEntry.name });
        }
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
  // <version>/actors/<name>/<name>.<ext>, relative to shared-async-op/ (the
  // global registry's own directory).
  const relParts = [version, "actors", name, name];
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
 * Rewrites `<asyncWorkerRoot>/<lang>/shared-async-op/generated-registry.<ext>`
 * from every shared-async-op actor currently on disk for `lang` (the one
 * just written by {@linkcode createAsyncOperationLogic} included) — so
 * repeated `create-async-logic` calls accumulate into one global registry
 * across every `functionVersion`, instead of each call clobbering the last.
 * Unlike the FSM-scoped registries `generate-async-logic` writes (one per
 * `<fsmName>/<fsmVersion>`), this is deliberately a single flat file — these
 * actors have no owning FSM/version to partition by.
 */
async function rewriteSharedAsyncOpRegistry(
  asyncWorkerRoot: string,
  lang: OperationLang,
): Promise<string | undefined> {
  if (!isRegistryLang(lang)) return undefined;
  const existing = await listExistingSharedAsyncOpActors(asyncWorkerRoot, lang);
  const entries = existing.map(({ name, version }) =>
    toSharedAsyncOpRegistryEntry(lang, name, version)
  );
  const dir = `${asyncWorkerRoot}/${lang}/${SHARED_ASYNC_OP_DIR_NAME}`;
  await Deno.mkdir(dir, { recursive: true });
  const file = `${dir}/generated-registry.${
    lang === "typescript" ? "ts" : lang === "rust" ? "rs" : "py"
  }`;
  await Deno.writeTextFile(
    file,
    buildSharedAsyncOpRegistryContent(entries, lang),
  );
  return file;
}

/**
 * Rewrites `<asyncWorkerRoot>/<lang>/shared-async-op/<functionVersion>/actors-manifest.json`
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
 * Scaffolds a single new actor stub in the shared, non-FSM-scoped async
 * operation pool at
 * `{cwd}/async-worker/<lang>/shared-async-op/<functionVersion>/actors/<functionName>/<functionName>.<ext>`,
 * via the same {@linkcode writeActorFile} helper
 * `generateAsyncOperationLogicFromFolders` uses per invoke object — so stub
 * content/formatting matches the rest of the actor-scaffolding pipeline.
 * Always anchored at `writeRootAbsPath` (the CLI passes `Deno.cwd()`), like
 * `generate-sync-logic`/`generate-async-logic` (#305/#307) — there's no
 * `--folder` input at all, since these actors have no owning FSM tree to walk
 * in the first place.
 *
 * Also writes/rewrites two things, both derived from whatever's actually on
 * disk (not just this one call's own actor), so repeated calls accumulate
 * instead of clobbering each other:
 * - `{cwd}/async-worker/<lang>/shared-async-op/<functionVersion>/actors-manifest.json`
 *   — every actor at *this* `functionVersion`, for every language (see
 *   {@linkcode rewriteSharedAsyncOpManifest}).
 * - For `typescript`/`python`/`rust` (see {@linkcode ActorsBarrelLang}) only,
 *   that language's single **global** `generated-registry.*` at
 *   `{cwd}/async-worker/<lang>/shared-async-op/generated-registry.*`, across
 *   every `functionVersion` (see {@linkcode rewriteSharedAsyncOpRegistry}).
 *
 * Neither ever touches the FSM-scoped aggregate
 * (`<lang>-actors-registry.generated.ts`) — this pool is fully separate from
 * it. Every entry's identity is fixed to `parentFsmName`/`asyncOperationType`
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

  const registryFile = await rewriteSharedAsyncOpRegistry(
    asyncWorkerRoot,
    lang,
  );
  if (registryFile) {
    logger.info("Wrote actors registry {file}", { file: registryFile });
  }

  // One batched format call instead of per-file — see
  // generate-async-operation-logic.ts's doc comment for the same rationale
  // (only ever 1-2 files here, but keeps both scaffolding paths consistent).
  // actors-manifest.json is pre-formatted JSON, not deno-fmt/rustfmt content
  // -- same reasoning generate-async-operation-logic.ts's own manifest write
  // follows -- so it's excluded from both batches.
  const tsFiles = [file, registryFile].filter(
    (f): f is string => f !== undefined && lang === "typescript",
  );
  const rustFiles = [registryFile].filter(
    (f): f is string => f !== undefined && lang === "rust",
  );
  await formatTsFilesBestEffort(tsFiles);
  await formatRustFilesBestEffort(rustFiles);

  return file;
}
