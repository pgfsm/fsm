import { getLogger } from "@logtape/logtape";
import { relative } from "@std/path/posix";
import {
  DELAY_ACTION_NAME_PREFIX,
  DenoCommand,
  isNotFoundError,
  isValidPythonIdentifier,
  isVersionFolderName,
  toGoExportedName,
} from "./util.ts";
import type {
  ActorReference,
  ActorsBarrelLang,
  FsmMachineJson,
  OperationKind,
  OperationLang,
  RegisteredActor,
  SyncOperationType,
  WrittenActor,
} from "./types/index.ts";
import { deriveTemplateInput } from "./scaffold-templates/derive-template-input.ts";
import { getPreamble, getTemplate } from "./scaffold-templates/registry.ts";
import { render as renderTsActorsRegistry } from "./scaffold-templates/eta/typescript/actors-registry.generated.ts";
import { render as renderTsSyncOperationRegistry } from "./scaffold-templates/eta/typescript/sync-operation-registry.generated.ts";
import { render as renderTsSyncOperationRegistryAggregate } from "./scaffold-templates/eta/typescript/aggregate-generated-sync-operation-registry.generated.ts";
import { render as renderTsRunSyncWorker } from "./scaffold-templates/eta/typescript/run-sync-worker.generated.ts";
import { render as renderTsSyncWorkerDenoJson } from "./scaffold-templates/eta/typescript/sync-worker-deno-json.generated.ts";
import { render as renderTsActorsRegistryAggregate } from "./scaffold-templates/eta/typescript/actors-registry-aggregate.generated.ts";
import { render as renderPyActorsRegistry } from "./scaffold-templates/eta/python/actors-registry.generated.ts";
import { render as renderPyActorsRegistryAggregate } from "./scaffold-templates/eta/python/actors-registry-aggregate.generated.ts";
import { render as renderRustActorsRegistry } from "./scaffold-templates/eta/rust/actors-registry.generated.ts";
import { render as renderRustActorsRegistryAggregate } from "./scaffold-templates/eta/rust/actors-registry-aggregate.generated.ts";
import { render as renderGoActorsRegistryAggregate } from "./scaffold-templates/eta/go/actors-registry-aggregate.generated.ts";
import { render as renderGoModActor } from "./scaffold-templates/eta/go/go-mod-actor.generated.ts";
import { render as renderGoModAggregate } from "./scaffold-templates/eta/go/go-mod-aggregate.generated.ts";
import { render as renderTsRunAsyncWorker } from "./scaffold-templates/eta/typescript/run-async-worker.generated.ts";
import { render as renderTsWorkerSdkDenoJson } from "./scaffold-templates/eta/typescript/worker-sdk-deno-json.generated.ts";
import { render as renderPyRunAsyncWorker } from "./scaffold-templates/eta/python/run-async-worker.generated.ts";
import { render as renderPyWorkerSdkPyproject } from "./scaffold-templates/eta/python/worker-sdk-pyproject.generated.ts";
import { render as renderRustWorkerSdkMain } from "./scaffold-templates/eta/rust/worker-sdk-main.generated.ts";
import { render as renderRustWorkerSdkCargoToml } from "./scaffold-templates/eta/rust/worker-sdk-cargo-toml.generated.ts";
import { render as renderRustWorkerSdkGitignore } from "./scaffold-templates/eta/rust/worker-sdk-gitignore.generated.ts";
import { render as renderGoWorkerSdkMain } from "./scaffold-templates/eta/go/worker-sdk-main.generated.ts";
import { render as renderGoWorkerSdkSdk } from "./scaffold-templates/eta/go/worker-sdk-sdk.generated.ts";
import { render as renderGoWorkerSdkGitignore } from "./scaffold-templates/eta/go/worker-sdk-gitignore.generated.ts";

const logger = getLogger(["@pgfsm/compiler", "scaffold"]);

export const SUPPORTED_OPERATION_LANGS: OperationLang[] = [
  "typescript",
  "python",
  "rust",
  "go",
];

export function isOperationLang(value: string): value is OperationLang {
  return (SUPPORTED_OPERATION_LANGS as string[]).includes(value);
}

/** The index-module filename written for a given language. */
export function operationModuleFileName(lang: OperationLang): string {
  switch (lang) {
    case "typescript":
      return "index.ts";
    case "python":
      return "index.py";
    case "rust":
      return "mod.rs";
    case "go":
      return "index.go";
  }
}

/** The source-file extension for a given language. */
export function operationFileExtension(lang: OperationLang): string {
  switch (lang) {
    case "typescript":
      return "ts";
    case "python":
      return "py";
    case "rust":
      return "rs";
    case "go":
      return "go";
  }
}

/** Sanitizes a value for use as a filename component (keeps identifier chars). */
function sanitizeFileComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function renderStub(
  lang: OperationLang,
  kind: OperationKind,
  name: string,
): string {
  return getTemplate(lang, kind)(deriveTemplateInput(kind, name, lang));
}

/**
 * Each stub template ends in a blank line so consecutive stubs concatenated
 * into one module read with a separator between them — but that leaves a
 * stray trailing blank line at the true end of the file, which `deno fmt`
 * doesn't consider canonical (and silently strips on format-on-save/commit).
 * Collapses that down to a single trailing newline.
 */
function withSingleTrailingNewline(content: string): string {
  return content.replace(/\n+$/, "\n");
}

/**
 * Renders the full index-module content for a set of operation-logic names in a
 * given language. Names are deduplicated. Go modules get a package header named
 * after the kind.
 */
export function renderOperationModule(
  lang: OperationLang,
  kind: OperationKind,
  names: string[],
): string {
  const unique = [...new Set(names)];
  let out = getPreamble(lang, kind);
  for (const name of unique) {
    out += renderStub(lang, kind, name);
  }
  return withSingleTrailingNewline(out);
}

/**
 * Writes one operation-logic index module to
 * `<absFolderPath>/<lang>/<kind>/`, or `<absFolderPath>/<lang>/<subPath>/<kind>/`
 * when `subPath` is given — `generate-sync-logic`'s own caller uses this to
 * insert `<fsmName>/<fsmVersion>` between the language and the kind, so
 * multiple FSMs/versions writing under the same `<lang>` root don't collide.
 */
export async function writeOperationModule(
  absFolderPath: string,
  lang: OperationLang,
  kind: OperationKind,
  names: string[],
  subPath?: string,
): Promise<void> {
  const dir = subPath
    ? `${absFolderPath}/${lang}/${subPath}/${kind}`
    : `${absFolderPath}/${lang}/${kind}`;
  await Deno.mkdir(dir, { recursive: true });
  const file = `${dir}/${operationModuleFileName(lang)}`;
  await Deno.writeTextFile(file, renderOperationModule(lang, kind, names));
}

const SYNC_OPERATION_REGISTRY_FILE_NAME =
  "generated-sync-operation-registry.ts";

/** One `SyncOperationRegistration` entry's import-vs-registered-name pair. */
type SyncOperationEntry = { name: string; importName: string };

/**
 * One `writeOperationModule` kind's contribution to the registry: its
 * singular {@linkcode SyncOperationType} (what a registration entry's
 * `syncOperationType` is), its on-disk module folder (what the `import`
 * statement points at), and the names to register from it. Delay handlers are
 * exported under a `${DELAY_ACTION_NAME_PREFIX}`-prefixed name (see
 * `derive-template-input.ts`) — `importName` carries that prefix,
 * `name`/`syncOperationName` stays the original `fsm.json` reference.
 */
type SyncOperationGroup = {
  kind: SyncOperationType;
  moduleFile: Extract<OperationKind, "actions" | "guards" | "delays">;
  entries: SyncOperationEntry[];
};

/**
 * Writes one version's `generated-sync-operation-registry.ts` — the
 * sync-logic counterpart of {@linkcode writeActorsRegistry}, combining that
 * version's action/guard/delay stubs (already written to
 * `<absSyncWorkerLangFolderPath>/{actions,guards,delays}/index.ts` by
 * {@linkcode writeOperationModule}) into one self-describing
 * `SyncOperationRegistration[]` a worker can iterate without importing each
 * kind's module separately. Written as a sibling of those three kind folders
 * — i.e. into `absSyncWorkerLangFolderPath` itself, not a `<kind>/` beneath
 * it — since it imports from all three. TypeScript only for now, matching
 * `generate-sync-logic`'s own current scope (the CLI rejects every other
 * `OperationLang` for this command).
 */
export async function writeSyncOperationRegistry(
  absSyncWorkerLangFolderPath: string,
  fsmName: string,
  fsmVersion: string,
  lang: OperationLang,
  actions: string[],
  guards: string[],
  delays: string[],
): Promise<string> {
  const groups: SyncOperationGroup[] = [
    {
      kind: "action",
      moduleFile: "actions",
      entries: actions.map((name) => ({ name, importName: name })),
    },
    {
      kind: "guard",
      moduleFile: "guards",
      entries: guards.map((name) => ({ name, importName: name })),
    },
    {
      kind: "delay",
      moduleFile: "delays",
      entries: delays.map((name) => ({
        name,
        importName: `${DELAY_ACTION_NAME_PREFIX}${name}`,
      })),
    },
  ];

  await Deno.mkdir(absSyncWorkerLangFolderPath, { recursive: true });
  const file =
    `${absSyncWorkerLangFolderPath}/${SYNC_OPERATION_REGISTRY_FILE_NAME}`;
  await Deno.writeTextFile(
    file,
    renderTsSyncOperationRegistry({ fsmName, fsmVersion, lang, groups }),
  );
  return file;
}

const AGGREGATE_SYNC_OPERATION_REGISTRY_FILE_NAME =
  "aggregate-generated-sync-operation-registry.ts";

/**
 * Discovers every `<fsmName>/<fsmVersion>` group already written under
 * `absSyncWorkerTypescriptDir` — i.e. that has its own
 * {@linkcode writeSyncOperationRegistry} output
 * (`generated-sync-operation-registry.ts`) — the sync-logic counterpart of
 * `generate-async-operation-logic.ts`'s
 * {@linkcode collectRegisteredActorsFromAsyncWorkerDir}, simplified: sync
 * logic writes no manifest of its own, so `fsmName`/`fsmVersion` are read
 * directly off the two directory levels instead. Rebuilding from disk (not
 * just the group(s) the current run touched) keeps the aggregate complete
 * regardless of how many separate `generate-sync-logic` invocations — folder
 * mode and single-file `--fsm-json` mode alike — have contributed to
 * `absSyncWorkerTypescriptDir` over time; same rationale as the async
 * aggregate's own disk-rebuild. Returns `[]` when the directory doesn't exist
 * yet (e.g. `typescript` wasn't among the requested `langs`).
 *
 * Sorted by `fsmName` then `fsmVersion` before returning — `Deno.readDir`'s
 * iteration order isn't a stable contract, and an aggregate whose import
 * order shuffled between otherwise-identical regenerations would just be
 * unreviewable diff noise.
 */
async function collectSyncOperationRegistryGroups(
  absSyncWorkerTypescriptDir: string,
): Promise<{ fsmName: string; fsmVersion: string }[]> {
  const groups: { fsmName: string; fsmVersion: string }[] = [];

  let fsmEntries: Deno.DirEntry[];
  try {
    fsmEntries = await Array.fromAsync(
      Deno.readDir(absSyncWorkerTypescriptDir),
    );
  } catch (err) {
    if (isNotFoundError(err)) return groups;
    throw err;
  }

  for (const fsmEntry of fsmEntries) {
    if (!fsmEntry.isDirectory) continue;
    const fsmDir = `${absSyncWorkerTypescriptDir}/${fsmEntry.name}`;
    for await (const versionEntry of Deno.readDir(fsmDir)) {
      if (!versionEntry.isDirectory) continue;
      const registryPath =
        `${fsmDir}/${versionEntry.name}/${SYNC_OPERATION_REGISTRY_FILE_NAME}`;
      try {
        await Deno.stat(registryPath);
      } catch (err) {
        if (isNotFoundError(err)) continue;
        throw err;
      }
      groups.push({ fsmName: fsmEntry.name, fsmVersion: versionEntry.name });
    }
  }
  groups.sort((a, b) =>
    a.fsmName === b.fsmName
      ? a.fsmVersion.localeCompare(b.fsmVersion)
      : a.fsmName.localeCompare(b.fsmName)
  );
  return groups;
}

/**
 * Writes ONE aggregate sync-operation registry at
 * `<absSyncWorkerTypescriptDir>/aggregate-generated-sync-operation-registry.ts`
 * — combining every `<fsmName>/<fsmVersion>`'s own
 * `generated-sync-operation-registry.ts` (see
 * {@linkcode writeSyncOperationRegistry}) into one
 * `SYNC_OPERATION_REGISTRATIONS` array, the same "one fixed file a worker
 * build imports" shape {@linkcode writeAggregateActorsRegistry} gives async
 * actors — a sync worker process serves every FSM's action/guard/delay
 * handlers, not just one. TypeScript only, matching `generate-sync-logic`'s
 * own current scope. Returns `undefined` (writes nothing) when no
 * `<fsmName>/<fsmVersion>` group exists yet under `absSyncWorkerTypescriptDir`.
 */
export async function writeAggregateSyncOperationRegistry(
  absSyncWorkerTypescriptDir: string,
): Promise<string | undefined> {
  const groups = await collectSyncOperationRegistryGroups(
    absSyncWorkerTypescriptDir,
  );
  if (groups.length === 0) return undefined;

  const groupList = groups.map(({ fsmName, fsmVersion }) => {
    const key = `${fsmName}/${fsmVersion}`;
    return { key, alias: groupKeyToIdentifier(key), relDir: `./${key}` };
  });

  await Deno.mkdir(absSyncWorkerTypescriptDir, { recursive: true });
  const file =
    `${absSyncWorkerTypescriptDir}/${AGGREGATE_SYNC_OPERATION_REGISTRY_FILE_NAME}`;
  await Deno.writeTextFile(
    file,
    renderTsSyncOperationRegistryAggregate({ groups: groupList }),
  );
  return file;
}

const RUN_SYNC_WORKER_FILE_NAME = "run-sync-worker.ts";
const SYNC_WORKER_DENO_JSON_FILE_NAME = "deno.json";

/**
 * Writes a minimal runnable entry point,
 * `<absSyncWorkerTypescriptDir>/run-sync-worker.ts`, plus the `deno.json`
 * declaring `@pgfsm/sync-worker` as an npm import so that entry point's bare
 * specifier resolves — both siblings of
 * `aggregate-generated-sync-operation-registry.ts`
 * (see {@linkcode writeAggregateSyncOperationRegistry}), which `run-sync-worker.ts`
 * imports by relative path. `run-sync-worker.ts` itself is static content, no
 * per-project templating: it just imports `SYNC_OPERATION_REGISTRATIONS` and
 * calls `@pgfsm/sync-worker`'s `runFsmlet` with a `DATABASE_URL`-derived
 * `dbConfig` — mirrors `packages/fsm-sync-worker-ts/test-cli-sdk.ts` (adjusted
 * to the bare `@pgfsm/sync-worker` import this file needs, since it lives
 * alongside the aggregate registry rather than inside that package's own
 * tree). Only called when the aggregate registry itself was written (see
 * `generate-sync-operation-logic.ts`'s `writeSyncAggregateArtifacts`) — no
 * point in a runnable entry point importing an aggregate that doesn't exist.
 *
 * `deno.json`'s own `name` field is `projectName` when the caller supplies
 * one (`generate-sync-logic --project-name`), or else a random
 * `sync-worker-<8 hex chars>` — Deno's config schema treats a bare `name`
 * with no `exports` as an incomplete JSR-publish config (hence this file
 * also sets `exports`, even though nothing here is actually meant for JSR),
 * so a name is always written rather than left out.
 */
export async function writeSyncWorkerRunner(
  absSyncWorkerTypescriptDir: string,
  projectName?: string,
): Promise<{ runFile: string; denoJsonFile: string }> {
  await Deno.mkdir(absSyncWorkerTypescriptDir, { recursive: true });

  const runFile = `${absSyncWorkerTypescriptDir}/${RUN_SYNC_WORKER_FILE_NAME}`;
  await Deno.writeTextFile(runFile, renderTsRunSyncWorker({}));

  const name = projectName ??
    `sync-worker-${crypto.randomUUID().split("-")[0]}`;
  const denoJsonFile =
    `${absSyncWorkerTypescriptDir}/${SYNC_WORKER_DENO_JSON_FILE_NAME}`;
  await Deno.writeTextFile(denoJsonFile, renderTsSyncWorkerDenoJson({ name }));

  return { runFile, denoJsonFile };
}

/**
 * Base filename (without extension) for a per-actor file: the sanitized `src`.
 */
export function actorFileBaseName(actor: ActorReference): string {
  return sanitizeFileComponent(actor.src);
}

/**
 * Derives the Go module path for a single actor's own `go.mod`, matching the
 * convention already established by hand for `apps/fsm-core-example`'s Go
 * actors (see `CheckReportsTable/go.mod`):
 * `<appRoot>/<fsmName>/<version>/go/actors/<actorDir>`, lowercased.
 * `<appRoot>` is normally derived as the directory name two levels above the
 * FSM's plugin root (e.g. `apps/fsm-core-example/fsm/creditCheck/v01` ->
 * appRoot `fsm-core-example`) — that offset assumes the fixed
 * `<appRoot>/<pluginRoot>/<fsmName>/<version>` depth every
 * {@linkcode eachVersionedFsmFolder} caller has. Callers whose `absFolderPath`
 * doesn't nest that deeply (e.g. `create-async-logic.ts`'s
 * `<appRoot>/shared-async-op/<version>`, missing the plugin-root layer) must
 * pass `appRootOverride` instead of relying on the offset. Each Go actor is
 * its own Go module so a consumer in a different module (e.g. a
 * worker-sdk/go build) can pull it in via a `require`/`replace` directive —
 * Go has no dynamic-loading equivalent to TS/Python's `import()`/`importlib`.
 */
function goActorModulePath(
  absFolderPath: string,
  actorDirName: string,
  appRootOverride?: string,
  subPath?: string,
): string {
  const { fsmName, fsmVersion } = fsmIdentityFromVersionFolderPath(
    subPath ? `${absFolderPath}/${subPath}` : absFolderPath,
  );
  const appRoot = appRootOverride ?? absFolderPath.split("/").at(-4)!; // .../<appRoot>/fsm/<fsmName>/<version>
  return `${appRoot}/${fsmName.toLowerCase()}/${fsmVersion}/go/actors/${actorDirName.toLowerCase()}`;
}

/**
 * Extracts `{ fsmName, fsmVersion }` from a version-folder absolute path
 * (e.g. `.../apps/fsm-core-example/fsm/creditCheck/v01` ->
 * `{ fsmName: "creditCheck", fsmVersion: "v01" }`), matching the
 * `<pluginRoot>/<fsmName>/<version>` convention {@linkcode eachVersionedFsmFolder}
 * walks. Exported for {@linkcode writeSyncOperationRegistry}'s caller
 * (`generate-sync-operation-logic.ts`), which needs the same identity for its
 * registry entries and has the same single-file-`--output`-mode caveat
 * `toRegisteredActor`'s own callers already accept (see #218) — an `--output`
 * that doesn't sit at this depth produces a wrong-but-harmless
 * `fsmName`/`fsmVersion` in the registry, not a crash.
 */
export function fsmIdentityFromVersionFolderPath(
  absFolderPath: string,
): { fsmName: string; fsmVersion: string } {
  const parts = absFolderPath.split("/");
  return { fsmVersion: parts.at(-1)!, fsmName: parts.at(-2)! };
}

/** Writes the `go.mod` for a single Go actor's own module (see {@linkcode goActorModulePath}). */
async function writeGoActorModule(
  absFolderPath: string,
  actorDirName: string,
  appRootOverride?: string,
  subPath?: string,
): Promise<void> {
  const modulePath = goActorModulePath(
    absFolderPath,
    actorDirName,
    appRootOverride,
    subPath,
  );
  const dir = subPath
    ? `${absFolderPath}/go/${subPath}/actors/${actorDirName}`
    : `${absFolderPath}/go/actors/${actorDirName}`;
  await Deno.writeTextFile(
    `${dir}/go.mod`,
    renderGoModActor({ modulePath }),
  );
}

/**
 * Writes a single actor to its own file at
 * `<absFolderPath>/<lang>/actors/<src>/<src>.<ext>`, or
 * `<absFolderPath>/<lang>/<subPath>/actors/<src>/<src>.<ext>` when `subPath`
 * is given — `generate-async-logic`'s own caller uses this to insert
 * `<fsmName>/<fsmVersion>` between the language and `actors/`, so multiple
 * FSMs/versions writing under the same `<lang>` root don't collide (mirrors
 * {@linkcode writeOperationModule}'s `subPath`); `create-async-logic.ts`'s
 * shared-async-op pool passes `shared-async-op/<functionVersion>` there too
 * (see that file's own doc comment).
 * The file exports one function named after the actor `src` — except Go,
 * whose function is exported (capitalized) instead, and which also gets its
 * own `go.mod` (see {@linkcode writeGoActorModule}), since Go enforces
 * exports and module boundaries at compile time. `appRootOverride` is passed
 * through to {@linkcode writeGoActorModule} for callers whose
 * `absFolderPath` doesn't nest at the standard plugin-root depth (see
 * {@linkcode goActorModulePath}); ignored for every other language.
 * Returns the absolute path written.
 */
export async function writeActorFile(
  absFolderPath: string,
  lang: OperationLang,
  actor: ActorReference,
  appRootOverride?: string,
  subPath?: string,
): Promise<string> {
  const name = actorFileBaseName(actor);
  const dir = subPath
    ? `${absFolderPath}/${lang}/${subPath}/actors/${name}`
    : `${absFolderPath}/${lang}/actors/${name}`;
  await Deno.mkdir(dir, { recursive: true });
  const file = `${dir}/${name}.${operationFileExtension(lang)}`;
  const header = getPreamble(lang, "actors");
  await Deno.writeTextFile(
    file,
    withSingleTrailingNewline(header + renderStub(lang, "actors", actor.src)),
  );
  if (lang === "go") {
    await writeGoActorModule(
      absFolderPath,
      name,
      appRootOverride,
      subPath,
    );
  }
  return file;
}

/** Builds the {@linkcode WrittenActor} record for the file a {@linkcode writeActorFile} call for this actor produces. */
export function toWrittenActor(
  lang: OperationLang,
  actor: ActorReference,
): WrittenActor {
  const fileBaseName = actorFileBaseName(actor);
  return {
    src: actor.src,
    fileBaseName,
    asyncOperationLanguage: lang,
    filePath: `actors/${fileBaseName}/${fileBaseName}.${
      operationFileExtension(lang)
    }`,
    exportedName: lang === "go" ? toGoExportedName(actor.src) : actor.src,
  };
}

/**
 * Builds the {@linkcode RegisteredActor} record for the file a
 * {@linkcode writeActorFile} call for this actor produces, given the
 * version-folder path it was written under.
 */
export function toRegisteredActor(
  absFolderPath: string,
  lang: OperationLang,
  actor: ActorReference,
): RegisteredActor {
  const written = toWrittenActor(lang, actor);
  const { fsmName: parentFsmName, fsmVersion: parentFsmVersion } =
    fsmIdentityFromVersionFolderPath(absFolderPath);
  return {
    ...written,
    parentFsmName,
    parentFsmVersion,
    asyncOperationType: "internalAsyncOperation",
    asyncOperationName: written.src,
    asyncOperationVersion: parentFsmVersion,
  };
}

/**
 * Writes a single JSON manifest listing every actor written for the caller's
 * `actors` array, at `<absFolderPath>/actors-manifest.json`. Always written,
 * even when `actors` is empty, so a consumer always knows where to look.
 * `generate-async-operation-logic.ts` writes one per language now (`actors`
 * pre-filtered to that language, `absFolderPath` the language's own
 * `<fsmName>/<fsmVersion>` directory) rather than one combined manifest
 * across every language, since actor output is no longer colocated under one
 * shared version-folder root — see {@linkcode writeActorFile}'s `subPath`.
 *
 * Takes {@linkcode RegisteredActor}, not just {@linkcode WrittenActor} — the
 * manifest carries the full activity-registration identity (parent FSM
 * name/version, `asyncOperationType`/`Name`/`Version`), the same fields the
 * aggregate registries already emit, not just the file-write-time subset
 * (`src`/`asyncOperationLanguage`/`filePath`/`exportedName`) — a consumer
 * shouldn't have to cross-reference the parent `fsm.json` to know which
 * FSM/version/invoke an entry belongs to (#320). `exportedName` is
 * serialized as `exportedAsyncOperationName` in the manifest's own JSON key
 * (the in-memory `RegisteredActor.exportedName` field name is unaffected —
 * this is a manifest-output-only rename).
 */
export async function writeActorsManifest(
  absFolderPath: string,
  actors: RegisteredActor[],
): Promise<string> {
  const file = `${absFolderPath}/actors-manifest.json`;
  const manifest = {
    actors: actors.map((
      {
        parentFsmName,
        parentFsmVersion,
        src,
        asyncOperationName,
        asyncOperationType,
        asyncOperationVersion,
        asyncOperationLanguage,
        filePath,
        exportedName,
      },
    ) => ({
      parentFsmName,
      parentFsmVersion,
      src,
      asyncOperationName,
      asyncOperationType,
      asyncOperationVersion,
      asyncOperationLanguage,
      filePath,
      exportedAsyncOperationName: exportedName,
    })),
  };
  await Deno.writeTextFile(file, JSON.stringify(manifest, null, 2) + "\n");
  return file;
}

const ACTORS_BARREL_FILE_NAME: Record<ActorsBarrelLang, string> = {
  typescript: "index.ts",
  python: "__init__.py",
  rust: "mod.rs",
};

/** Renders the barrel entry for one actor. Rust needs `#[path]` since the actor file isn't at Rust's default module location. */
function actorsBarrelEntry(
  lang: ActorsBarrelLang,
  actor: WrittenActor,
): string {
  const { src, fileBaseName } = actor;
  switch (lang) {
    case "typescript":
      return `export { ${src} } from "./${fileBaseName}/${fileBaseName}.ts";`;
    case "python":
      return `from .${fileBaseName}.${fileBaseName} import ${src}`;
    case "rust":
      return `#[path = "${fileBaseName}/${fileBaseName}.rs"]\n#[allow(non_snake_case)]\nmod ${fileBaseName};\npub use ${fileBaseName}::${src};`;
  }
}

/**
 * Writes a barrel module re-exporting every actor for one language, at
 * `<absFolderPath>/<lang>/actors/<barrel filename>`, or
 * `<absFolderPath>/<lang>/<subPath>/actors/<barrel filename>` when `subPath`
 * is given (see {@linkcode writeActorFile}'s own `subPath`) — `index.ts`/
 * `__init__.py`/`mod.rs`. Returns `undefined` (writes nothing) when there are
 * no actors for that language.
 */
export async function writeActorsBarrel(
  absFolderPath: string,
  actors: WrittenActor[],
  lang: ActorsBarrelLang,
  subPath?: string,
): Promise<string | undefined> {
  const langActors = actors.filter((a) => a.asyncOperationLanguage === lang);
  if (langActors.length === 0) return undefined;

  const dir = subPath
    ? `${absFolderPath}/${lang}/${subPath}/actors`
    : `${absFolderPath}/${lang}/actors`;
  await Deno.mkdir(dir, { recursive: true });
  const file = `${dir}/${ACTORS_BARREL_FILE_NAME[lang]}`;
  // Rust entries are 3 lines each — a blank line between actors keeps it readable.
  const separator = lang === "rust" ? "\n\n" : "\n";
  const content = langActors.map((a) => actorsBarrelEntry(lang, a)).join(
    separator,
  ) + "\n";
  await Deno.writeTextFile(file, content);
  return file;
}

const ACTORS_REGISTRY_FILE_NAME: Record<ActorsBarrelLang, string> = {
  typescript: "generated-registry.ts",
  python: "generated_registry.py",
  rust: "generated_registry.rs",
};

/**
 * Renders one FSM-version's registry file content via the language's Eta
 * template (`scaffold-templates/eta/<lang>/actors-registry.eta`). The
 * registry file itself lives one level above `actors/` (see
 * {@linkcode writeActorsRegistry}'s own doc comment, #328), so every
 * import/`#[path]` here is prefixed `actors/` to reach an actor file or the
 * barrel from there. Used by {@linkcode writeActorsRegistry} only — the
 * aggregate ({@linkcode writeAggregateActorsRegistry}) re-uses these
 * per-version files rather than re-deriving entries itself (see its own doc
 * comment for why).
 */
function buildActorsRegistryContent(
  langActors: RegisteredActor[],
  lang: ActorsBarrelLang,
): string {
  switch (lang) {
    case "typescript":
      return renderTsActorsRegistry({ actors: langActors });
    case "python":
      return renderPyActorsRegistry({ actors: langActors });
    case "rust":
      return renderRustActorsRegistry({ actors: langActors });
  }
}

/**
 * Writes a registration registry re-exporting every actor for one language,
 * at `<absFolderPath>/<lang>/<registry filename>`, or
 * `<absFolderPath>/<lang>/<subPath>/<registry filename>` when `subPath` is
 * given (see {@linkcode writeActorFile}'s own `subPath`) — one level above
 * `actors/`, unlike {@linkcode writeActorFile}/{@linkcode writeActorsBarrel}
 * (#328: previously colocated inside `actors/` alongside the barrel; moved
 * out so the registry sits at the same `<fsmName>/<fsmVersion>` level the
 * aggregate's own per-group import expects, see
 * {@linkcode writeAggregateActorsRegistry}). Unlike
 * {@linkcode writeActorsBarrel} (named exports, for consumers who know the
 * actor name at compile time), this is for runtime dispatch — what a worker
 * SDK needs to register with the Activity Gateway and route an invocation to
 * the right function, without a folder scan or dynamic
 * `import()`/`importlib`. Returns `undefined` (writes nothing) when there are
 * no actors for that language.
 */
export async function writeActorsRegistry(
  absFolderPath: string,
  actors: RegisteredActor[],
  lang: ActorsBarrelLang,
  subPath?: string,
): Promise<string | undefined> {
  const langActors = actors.filter((a) => a.asyncOperationLanguage === lang);
  if (langActors.length === 0) return undefined;

  const dir = subPath
    ? `${absFolderPath}/${lang}/${subPath}`
    : `${absFolderPath}/${lang}`;
  await Deno.mkdir(dir, { recursive: true });
  const file = `${dir}/${ACTORS_REGISTRY_FILE_NAME[lang]}`;
  await Deno.writeTextFile(file, buildActorsRegistryContent(langActors, lang));
  return file;
}

/**
 * Runs `deno fmt` once across every path passed in, so it matches what
 * `deno fmt --check` (the repo's pre-commit hook) expects — mirrors
 * {@linkcode formatRustFilesBestEffort}/{@linkcode formatGoFilesBestEffort}.
 * Needed because scaffolded content isn't hand-wrapped to the configured
 * line width — e.g. a long actor name is enough to push the generated
 * `return { input, msg: "..." }` stub past it. Callers collect every
 * `.ts` path a whole scaffolding run wrote and call this once at the end,
 * rather than once per file as each was written — same result, fewer
 * subprocess spawns. Best-effort: silently does nothing if `paths` is
 * empty, `deno` isn't on `PATH`, or running under the npm/npx build (no
 * {@linkcode DenoCommand} there — see its doc comment).
 */
export async function formatTsFilesBestEffort(
  paths: string[],
): Promise<void> {
  if (paths.length === 0 || !DenoCommand) return;
  try {
    await new DenoCommand("deno", { args: ["fmt", ...paths], stderr: "null" })
      .output();
  } catch {
    // deno not on PATH — leave the files as generated.
  }
}

/**
 * Runs `rustfmt` once across every path passed in, so it matches what
 * `cargo fmt --check` expects — needed once a generated registry is
 * actually `#[path]`-included into a real crate (e.g. worker-sdk/rust),
 * since our own codegen doesn't hand-replicate rustfmt's line-wrapping
 * rules. See {@linkcode formatTsFilesBestEffort} for the batching
 * rationale. Best-effort: silently does nothing if `paths` is empty,
 * `rustfmt` isn't on `PATH` (matching this file's existing tolerance for
 * missing toolchains elsewhere — see `validate-async-operation-logic.ts`'s
 * checker compilation), or running under the npm/npx build (no
 * {@linkcode DenoCommand} there).
 */
export async function formatRustFilesBestEffort(
  paths: string[],
): Promise<void> {
  if (paths.length === 0 || !DenoCommand) return;
  try {
    // --edition / --style-edition 2021: two separate rustfmt settings, both
    // needed. `--edition` alone (which `cargo fmt` derives from Cargo.toml)
    // is NOT enough on standalone `rustfmt` -- `--style-edition` (RFC 3338,
    // default 2015 even with --edition 2021 set) is what actually governs
    // formatting decisions like macro/println! call wrapping, and `cargo
    // fmt` sets it implicitly from the crate's edition in a way the bare
    // rustfmt binary doesn't. Without both flags, output here wouldn't match
    // what `cargo fmt --check` expects.
    await new DenoCommand("rustfmt", {
      args: ["--edition", "2021", "--style-edition", "2021", ...paths],
      stderr: "null",
    }).output();
  } catch {
    // rustfmt not installed — leave the files as generated.
  }
}

/**
 * Reserved directory (relative to `writeRootAbsPath`, i.e. `Deno.cwd()` at
 * CLI invocation time — see `generate-async-operation-logic.ts`) every
 * async-logic artifact lives under, aggregate worker-sdk files (registry,
 * cli/main, sdk) and per-`<fsmName>/<fsmVersion>` actor output
 * alike — one shared root per language so the whole worker SDK ships from a
 * single self-contained directory, e.g.
 * `async-worker/typescript/{run-async-worker.ts,deno.json,typescript-actors-registry.generated.ts,<fsmName>/<fsmVersion>/actors/...}`.
 * Exported so `generate-async-operation-logic.ts` can build the same
 * `<writeRootAbsPath>/async-worker/<lang>/<fsmName>/<fsmVersion>` paths for
 * its own per-version writes (`writeActorFile`/`writeActorsBarrel`/
 * `writeActorsRegistry`/`writeActorsManifest` calls) without hardcoding the
 * literal a second time.
 */
export const ASYNC_WORKER_DIR_NAME = "async-worker";

const AGGREGATE_ACTORS_REGISTRY_FILE_NAME: Record<ActorsBarrelLang, string> = {
  typescript: "typescript-actors-registry.generated.ts",
  // Must be a valid Python module identifier (no dashes).
  python: "python_actors_registry_generated.py",
  rust: "rust-actors-registry.generated.rs",
};

/** Groups actors by their parent `<fsmName>/<fsmVersion>`, preserving first-seen order. */
function groupByParentFsm(
  actors: RegisteredActor[],
): Map<string, RegisteredActor[]> {
  const groups = new Map<string, RegisteredActor[]>();
  for (const a of actors) {
    const key = `${a.parentFsmName}/${a.parentFsmVersion}`;
    const group = groups.get(key);
    if (group) {
      group.push(a);
    } else {
      groups.set(key, [a]);
    }
  }
  return groups;
}

/** A `<fsmName>/<fsmVersion>` group key turned into a valid TS/Python/Rust identifier. */
function groupKeyToIdentifier(key: string): string {
  return key.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
}

/**
 * Validates that every folder-name segment a Python aggregate import's
 * dotted path is built from (`fsm.<fsmName>.<fsmVersion>...`) is a valid
 * Python identifier. Unlike TS's string import specifiers or Rust's
 * `#[path]` (which accept arbitrary path strings), Python's `import a.b.c`
 * syntax requires each segment to already be a real, identifier-safe
 * directory name on disk — there's no way to sanitize around a mismatch, so
 * this fails the build with a clear error instead of letting `deno task
 * generate:templates`' output silently fail to import at worker-sdk runtime.
 */
function assertPythonAggregateImportPathsAreValid(
  groupKeys: string[],
): void {
  const segments = groupKeys.flatMap((key) => key.split("/"));
  const invalid = [
    ...new Set(segments.filter((s) => !isValidPythonIdentifier(s))),
  ];
  if (invalid.length > 0) {
    throw new Error(
      `Python worker-sdk aggregate registry codegen requires every FSM-name/version folder name to be a valid Python identifier (letters, digits, underscores, not starting with a digit, not a keyword) since it statically imports them via a dotted path. Invalid folder name(s): ${
        invalid.join(", ")
      }`,
    );
  }
}

/**
 * A POSIX relative path from `fromDir` to `toDir`, always prefixed with
 * `./` or `../` — `@std/path`'s `relative()` omits the leading `./` for a
 * plain descendant (e.g. `relative("/a/b", "/a/b/c")` → `"c"`), which reads
 * as a bare package specifier to TS/Deno and a Go module path to `go.mod`'s
 * `replace` directive, not a relative filesystem path. Both require the
 * explicit prefix; Rust's `#[path]` and Python's `sys.path` entry don't
 * strictly need it but accept it fine.
 */
export function relativeImportDir(fromDir: string, toDir: string): string {
  const rel = relative(fromDir, toDir);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Renders the aggregate registry content for one language, combining every
 * FSM-version group's actors, via the language's Eta template
 * (`scaffold-templates/eta/<lang>/actors-registry-aggregate.eta`). TS/Python
 * re-import each FSM-version's already-generated
 * {@linkcode writeActorsRegistry} output and flatten it — simpler and avoids
 * re-deriving every entry, since both languages can statically import an
 * arbitrarily-nested sibling file (Python via a dotted `sys.path`-relative
 * import, see {@linkcode assertPythonAggregateImportPathsAreValid}; TS via a
 * plain relative specifier). Rust can't do the equivalent (each per-version
 * `generated_registry.rs` defines its own nominally distinct
 * `ActorRegistration` type, so `Vec`s of them can't be concatenated) —
 * instead it `#[path]`-includes each FSM-version's actor barrel (`mod.rs`,
 * functions only, no competing type) under a unique per-group module alias,
 * and re-derives entries against one `ActorRegistration` type defined once
 * in the template.
 *
 * `writeDir` is `<writeRootAbsPath>/async-worker/<lang>` — the aggregate
 * file's own directory, and (unlike the old `worker-sdk-generated/` layout)
 * also the direct parent of every `<fsmName>/<fsmVersion>/` this run wrote
 * (see {@linkcode writeActorFile}'s `subPath`), so the relative import back
 * to each group is always trivially `./<fsmName>/<fsmVersion>` — no longer a
 * real cross-tree `relative()` computation against a separate FSM source
 * tree, now that both live under the same `async-worker/<lang>/` root by
 * construction.
 */
function buildAggregateRegistryContent(
  langActors: RegisteredActor[],
  lang: ActorsBarrelLang,
): string {
  const groups = groupByParentFsm(langActors);
  const groupList = [...groups.keys()].map((key) => ({
    key,
    alias: groupKeyToIdentifier(key),
    relDir: `./${key}`,
  }));

  switch (lang) {
    case "typescript":
      return renderTsActorsRegistryAggregate({
        groups: groupList,
      });
    case "python":
      assertPythonAggregateImportPathsAreValid(
        groupList.map((g) => g.key),
      );
      return renderPyActorsRegistryAggregate({
        groups: groupList,
        pluginRootRelPath: ".",
      });
    case "rust": {
      const actorsWithAlias = langActors.map((a) => ({
        ...a,
        alias: groupKeyToIdentifier(`${a.parentFsmName}/${a.parentFsmVersion}`),
      }));
      return renderRustActorsRegistryAggregate({
        groups: groupList,
        actors: actorsWithAlias,
      });
    }
  }
}

/**
 * Writes ONE aggregate registration registry per language at
 * `<writeRootAbsPath>/async-worker/<lang>/<aggregate filename>` — alongside
 * that language's `cli`/`main` entrypoint (see {@linkcode writeWorkerSdk})
 * and every `<fsmName>/<fsmVersion>/` this run wrote for that language (see
 * {@linkcode writeActorFile}'s `subPath`), combining actors across every
 * FSM/version processed in a single run (see
 * `generateAsyncOperationLogicFromFolders`). This is the fixed, known file a
 * worker SDK build imports — a worker process serves every actor for its
 * language across the whole plugin root, so its build has exactly one thing
 * to import, not a per-FSM-version file it would have to discover. Returns
 * `undefined` (writes nothing) when there are no actors for that language
 * across the whole run.
 */
export async function writeAggregateActorsRegistry(
  writeRootAbsPath: string,
  actors: RegisteredActor[],
  lang: ActorsBarrelLang,
): Promise<string | undefined> {
  const langActors = actors.filter((a) => a.asyncOperationLanguage === lang);
  if (langActors.length === 0) return undefined;

  const dir = `${writeRootAbsPath}/${ASYNC_WORKER_DIR_NAME}/${lang}`;
  await Deno.mkdir(dir, { recursive: true });
  const file = `${dir}/${AGGREGATE_ACTORS_REGISTRY_FILE_NAME[lang]}`;
  await Deno.writeTextFile(
    file,
    buildAggregateRegistryContent(langActors, lang),
  );
  return file;
}

/** Go module path for one actor, given the aggregate's app-root name (see {@linkcode goActorModulePath}, which this mirrors for a `RegisteredActor` rather than a version-folder path). */
function goActorModulePathFromRegisteredActor(
  appRoot: string,
  a: RegisteredActor,
): string {
  return `${appRoot}/${a.parentFsmName.toLowerCase()}/${a.parentFsmVersion}/go/actors/${a.fileBaseName.toLowerCase()}`;
}

/** A valid Go import alias derived from an actor's identity — unique per actor, since (unlike TS/Python/Rust barrels) each Go actor is its own separate module/import. */
function goImportAlias(a: RegisteredActor): string {
  return `${a.parentFsmName}_${a.parentFsmVersion}_${a.fileBaseName}`
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
}

const GO_AGGREGATE_DIR_NAME = "go-actors-registry-generated";

/** Runs `gofmt -w` once across every path passed in. See {@linkcode formatTsFilesBestEffort} for the batching rationale; same best-effort tolerance (empty `paths`, missing `gofmt`, npm/npx build). */
export async function formatGoFilesBestEffort(
  paths: string[],
): Promise<void> {
  if (paths.length === 0 || !DenoCommand) return;
  try {
    await new DenoCommand("gofmt", { args: ["-w", ...paths], stderr: "null" })
      .output();
  } catch {
    // gofmt not installed — leave the files as generated.
  }
}

/**
 * Runs `go mod tidy` once per generated Go module directory passed in —
 * still one subprocess per directory (each `go.mod` is its own module;
 * `go mod tidy` has no multi-module batch mode), but centralized into a
 * single call site instead of scattered across every write function that
 * happens to produce a `go.mod`, matching the batching this file's other
 * formatters use (see {@linkcode formatTsFilesBestEffort}).
 * `renderGoModAggregate` only ever writes the `require`/`replace` pairs
 * it's explicitly given — it has no notion of a dependency's own
 * transitive deps (e.g. grpc-go pulls in `golang.org/x/net`,
 * `google.golang.org/protobuf`, etc.) or which Go version those deps need,
 * so a freshly-scaffolded `go.mod` fails
 * `go build` until tidied. Silently does nothing per directory if `go`
 * isn't on `PATH`, if tidying fails (e.g. a unit test's fixture `replace`
 * targets don't exist on disk), or if running under the npm/npx build (no
 * {@linkcode DenoCommand} there) — leaves each `go.mod` as generated either
 * way.
 */
export async function goModTidyManyBestEffort(dirs: string[]): Promise<void> {
  if (!DenoCommand) return;
  for (const dir of dirs) {
    try {
      await new DenoCommand("go", {
        args: ["mod", "tidy"],
        cwd: dir,
        stdout: "null",
        stderr: "null",
      }).output();
    } catch {
      // go not installed, or tidying failed — leave go.mod as generated.
    }
  }
}

/**
 * Writes a standalone Go module aggregating every Go actor across the whole
 * run into one `ActorRegistrations()` function, at
 * `<writeRootAbsPath>/async-worker/go/go-actors-registry-generated/`
 * (`go.mod` + `registry.go`) — nested inside the `go/` worker-sdk directory
 * (see {@linkcode writeWorkerSdk}), alongside `main.go`. Returns `undefined`
 * (writes nothing) when there are no Go actors.
 *
 * Go actors are each their own module (see {@linkcode writeGoActorModule}) —
 * pulling one into a consumer requires a `require`/`replace` directive per
 * actor, which can't live in a single flat file the way TS/Python/Rust's
 * aggregate does (they need no module-boundary bookkeeping). Generating that
 * wiring here means a *consumer's* `go.mod` (worker-sdk/go, one directory up)
 * only ever needs ONE `require`/`replace`, pointing at this module, instead
 * of being hand-edited every time a Go actor is added or removed. The
 * module's own logical name (`<goModuleAppRoot>/go-actors-registry-generated`)
 * is unrelated to its on-disk nesting — Go resolves it via this module's
 * `require`+`replace`, so it doesn't need to change even though the
 * directory now sits three levels below the app root instead of one.
 *
 * `goModuleAppRoot` is the *real* app-root directory name (e.g.
 * `"fsm-core-example"`) that each individual actor's own `go.mod` already
 * names itself under (see {@linkcode goActorModulePath}) — a purely logical
 * name, independent of where files physically live. Each actor's own `go.mod`
 * physically lives at
 * `<writeRootAbsPath>/async-worker/go/<fsmName>/<fsmVersion>/actors/<fileBaseName>/go.mod`
 * (see {@linkcode writeActorFile}'s `subPath`) — always directly reachable
 * from `writeRootAbsPath` now that both this aggregate and every actor's own
 * module live under the same `async-worker/go/` root by construction.
 */
export async function writeAggregateGoRegistry(
  writeRootAbsPath: string,
  goModuleAppRoot: string,
  actors: RegisteredActor[],
): Promise<string | undefined> {
  const goActors = actors.filter((a) => a.asyncOperationLanguage === "go");
  if (goActors.length === 0) return undefined;

  const dir =
    `${writeRootAbsPath}/${ASYNC_WORKER_DIR_NAME}/go/${GO_AGGREGATE_DIR_NAME}`;
  await Deno.mkdir(dir, { recursive: true });

  const withMeta = goActors.map((a) => ({
    ...a,
    modulePath: goActorModulePathFromRegisteredActor(goModuleAppRoot, a),
    alias: goImportAlias(a),
  }));

  const goModContent = renderGoModAggregate({
    moduleName: `${goModuleAppRoot}/${GO_AGGREGATE_DIR_NAME}`,
    requires: withMeta.map((a) => ({ modulePath: a.modulePath })),
    replaces: withMeta.map((a) => ({
      modulePath: a.modulePath,
      target: relativeImportDir(
        dir,
        `${writeRootAbsPath}/${ASYNC_WORKER_DIR_NAME}/go/${a.parentFsmName}/${a.parentFsmVersion}/actors/${a.fileBaseName}`,
      ),
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
  return registryFile;
}

/**
 * The TypeScript worker SDK's files from before #358, when this function
 * wrote the whole SDK into every project instead of a thin
 * `run-async-worker.ts` importing `@pgfsm/async-worker-sdk`. Removed on
 * regeneration (see {@linkcode removeStaleGeneratedFile}) since they import
 * packages the new `deno.json` no longer declares.
 */
const LEGACY_TS_WORKER_SDK_FILES = ["cli.ts", "sdk.ts"];

/**
 * The Python worker SDK's files from before #364: the whole SDK
 * (`sdk.py`/`cli.py`) plus a `requirements.txt` editable-installing
 * `pgfsm-proto-codegen` from this monorepo. Now a thin `run_async_worker.py`
 * imports the published `pgfsm-async-worker-sdk`, pinned by `pyproject.toml`.
 */
const LEGACY_PY_WORKER_SDK_FILES = ["cli.py", "sdk.py", "requirements.txt"];

/**
 * The Rust worker SDK's file from before #368: the whole SDK as `src/sdk.rs`,
 * `mod`-included by the old `main.rs`. Now `main.rs` uses the published
 * `pgfsm-async-worker-sdk` crate, pinned by `Cargo.toml`.
 */
const LEGACY_RUST_WORKER_SDK_FILES = ["src/sdk.rs"];

/**
 * This compiler's auto-generated header, as a `//` or `#` comment, optionally
 * after a shebang line (the old Python `cli.py` had one).
 */
const AUTO_GENERATED_HEADER_RE =
  /^(#![^\n]*\n)?(\/\/|#) AUTO-GENERATED by fsm-compiler-ts\./;

/**
 * Deletes `path` if it exists and still starts with this compiler's
 * auto-generated header — a file the user has since edited or replaced
 * with their own is left alone.
 */
async function removeStaleGeneratedFile(path: string): Promise<void> {
  let content: string;
  try {
    content = await Deno.readTextFile(path);
  } catch (err) {
    if (isNotFoundError(err)) return;
    throw err;
  }
  if (!AUTO_GENERATED_HEADER_RE.test(content)) return;
  await Deno.remove(path);
  logger.info("Removed stale generated worker SDK file {path}", { path });
}
/**
 * Go module path (matching sidecar_gateway.proto's `go_package` option) for
 * the generated grpc-go stub (`packages/fsm-proto-codegen/gen/go/`) —
 * required+replaced in worker-sdk/go's own go.mod the same way each
 * compiled-in actor module is (see the `replace` comment in
 * {@linkcode writeWorkerSdk} below), since Go `replace` directives don't
 * propagate transitively through a dependency. This one's a bare module
 * path, not a filesystem path, so it stays a fixed constant — see
 * {@linkcode gatewaySidecarProtoGenGoRelPath} for the `replace` target.
 */
const GATEWAY_SIDECAR_PROTO_GEN_GO_MODULE_PATH =
  "github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go";
/**
 * The `replace` target for {@linkcode GATEWAY_SIDECAR_PROTO_GEN_GO_MODULE_PATH}.
 *
 * Computed via {@linkcode relativeImportDir} rather than a fixed depth —
 * `dir` (where this actually gets written) and `repoRootAbsPath` can be
 * arbitrarily far apart now that `writeRootAbsPath`/`--plugin-root` is a pure
 * write destination.
 */
function gatewaySidecarProtoGenGoRelPath(
  dir: string,
  repoRootAbsPath: string,
): string {
  return relativeImportDir(
    dir,
    `${repoRootAbsPath}/packages/fsm-proto-codegen/gen/go`,
  );
}

/**
 * Writes the cli/main entrypoint + sdk implementation + build
 * manifest for one language, at `<writeRootAbsPath>/async-worker/<lang>/`
 * — the same directory {@linkcode writeAggregateActorsRegistry} (TS/Python/
 * Rust) and {@linkcode writeAggregateGoRegistry} (Go) write that language's
 * aggregate registry into, and every `<fsmName>/<fsmVersion>/` this run wrote
 * for that language (see {@linkcode writeActorFile}'s `subPath`), so the
 * entire worker SDK for a language — registry and per-version actors alike —
 * ships from one self-contained directory a build can point at.
 * Returns `false` (writes nothing) when there are no actors for that language
 * across the whole run — matches every other aggregate writer in this file.
 * Also returns every `.ts`/`.rs`/`.go` path written (`tsFiles`/`rustFiles`/
 * `goFiles`) and the Go worker-sdk's module directory (`goModDir`, if any)
 * — this function doesn't format/tidy anything itself; callers batch these
 * into one end-of-run pass via {@linkcode formatTsFilesBestEffort} /
 * {@linkcode formatRustFilesBestEffort} / {@linkcode formatGoFilesBestEffort} /
 * {@linkcode goModTidyManyBestEffort} instead of per-file.
 *
 * TypeScript, Python and Rust get no SDK source at all: `run-async-worker.ts`
 * imports the published `@pgfsm/async-worker-sdk` package (#358),
 * `run_async_worker.py` the published `pgfsm-async-worker-sdk` (#364), and
 * Rust's `src/main.rs` the published `pgfsm-async-worker-sdk` crate (#368).
 * Go still gets `sdk.go` written out, which, unlike the registries, doesn't
 * vary per project at all — every project using this gateway gets
 * byte-identical content. It's still
 * rendered through Eta (a static template, no `<% %>` tags) rather than
 * written as plain strings, for the same reason every other generated file
 * in this package is: consistency, and so the "AUTO-GENERATED, do not edit"
 * header is never forgotten.
 *
 * `goModuleAppRoot` — see {@linkcode writeAggregateGoRegistry}'s doc comment;
 * same real-app-root-name-vs-write-location distinction applies here for the
 * Go worker-sdk's own consumer `go.mod`. This Go worker-sdk's own actor
 * `replace` targets are computed from `writeRootAbsPath` (where actors'
 * `go.mod`s now physically live — see {@linkcode writeActorFile}'s
 * `subPath`), not `realPluginRootAbsPath`. `realPluginRootAbsPath` (where the
 * actual FSM source tree lives) is used only to compute every
 * `gatewaySidecarProtoGen*` target — those point at a sibling package
 * elsewhere in *this monorepo* (`packages/fsm-proto-codegen/`), a
 * relationship that depends on where the source FSM tree sits relative to the
 * repo root, not on `writeRootAbsPath` (which can now be anywhere the caller
 * chooses).
 */
export async function writeWorkerSdk(
  writeRootAbsPath: string,
  goModuleAppRoot: string,
  realPluginRootAbsPath: string,
  actors: RegisteredActor[],
): Promise<{
  typescript: boolean;
  python: boolean;
  rust: boolean;
  go: boolean;
  tsFiles: string[];
  rustFiles: string[];
  goFiles: string[];
  goModDir?: string;
}> {
  const appRoot = goModuleAppRoot;
  // <realPluginRoot> sits at <repoRoot>/apps/<appName>/<pluginRootDirName>
  // -- three levels below repo root (same assumption the fixed-depth
  // GATEWAY_SIDECAR_* constants used to bake in directly).
  const repoRootAbsPath = realPluginRootAbsPath.split("/").slice(0, -3)
    .join("/");
  const hasLang = (lang: OperationLang) =>
    actors.some((a) => a.asyncOperationLanguage === lang);

  const tsFiles: string[] = [];
  const rustFiles: string[] = [];
  const goFiles: string[] = [];
  let goModDir: string | undefined;

  const wroteTypescript = hasLang("typescript");
  if (wroteTypescript) {
    const dir = `${writeRootAbsPath}/${ASYNC_WORKER_DIR_NAME}/typescript`;
    await Deno.mkdir(dir, { recursive: true });
    // The SDK itself lives in the published @pgfsm/async-worker-sdk package
    // (#358); this project only gets a thin entry point wiring its registry
    // into that package's runActorWorkerCli.
    const runFile = `${dir}/run-async-worker.ts`;
    await Deno.writeTextFile(
      runFile,
      renderTsRunAsyncWorker({
        registryImportPath: "./typescript-actors-registry.generated.ts",
      }),
    );
    tsFiles.push(runFile);
    for (const file of LEGACY_TS_WORKER_SDK_FILES) {
      await removeStaleGeneratedFile(`${dir}/${file}`);
    }

    // Scoped to this one language subdirectory, matching go.mod/Cargo.toml/
    // requirements.txt's own per-language placement below -- without it,
    // run-async-worker.ts's bare npm imports don't resolve at all once
    // async-worker/typescript/ sits outside the caller's own workspace
    // member import map (see #316, #318).
    await Deno.writeTextFile(`${dir}/deno.json`, renderTsWorkerSdkDenoJson({}));
  }

  const wrotePython = hasLang("python");
  if (wrotePython) {
    const dir = `${writeRootAbsPath}/${ASYNC_WORKER_DIR_NAME}/python`;
    await Deno.mkdir(dir, { recursive: true });
    // Same shape as TypeScript above: the SDK lives in the published
    // pgfsm-async-worker-sdk package (#364), pinned by this directory's
    // pyproject.toml; the project only gets a thin entry point.
    await Deno.writeTextFile(
      `${dir}/run_async_worker.py`,
      renderPyRunAsyncWorker({
        registryModuleName: AGGREGATE_ACTORS_REGISTRY_FILE_NAME.python.replace(
          /\.py$/,
          "",
        ),
      }),
    );
    await Deno.writeTextFile(
      `${dir}/pyproject.toml`,
      renderPyWorkerSdkPyproject({}),
    );
    for (const file of LEGACY_PY_WORKER_SDK_FILES) {
      await removeStaleGeneratedFile(`${dir}/${file}`);
    }
  }

  const wroteRust = hasLang("rust");
  if (wroteRust) {
    const dir = `${writeRootAbsPath}/${ASYNC_WORKER_DIR_NAME}/rust`;
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    const mainFile = `${dir}/src/main.rs`;
    // Same shape as TypeScript/Python above: the SDK lives in the published
    // pgfsm-async-worker-sdk crate (#368), pinned by this directory's
    // Cargo.toml; the project only gets a thin main.rs.
    await Deno.writeTextFile(
      mainFile,
      renderRustWorkerSdkMain({
        registryRelativePath: "../rust-actors-registry.generated.rs",
      }),
    );
    await Deno.writeTextFile(
      `${dir}/Cargo.toml`,
      renderRustWorkerSdkCargoToml({}),
    );
    for (const file of LEGACY_RUST_WORKER_SDK_FILES) {
      await removeStaleGeneratedFile(`${dir}/${file}`);
    }
    rustFiles.push(mainFile);
    await Deno.writeTextFile(
      `${dir}/.gitignore`,
      renderRustWorkerSdkGitignore({}),
    );
  }

  const wroteGo = hasLang("go");
  if (wroteGo) {
    const dir = `${writeRootAbsPath}/${ASYNC_WORKER_DIR_NAME}/go`;
    await Deno.mkdir(dir, { recursive: true });
    const mainFile = `${dir}/main.go`;
    await Deno.writeTextFile(mainFile, renderGoWorkerSdkMain({}));
    const sdkFile = `${dir}/sdk.go`;
    await Deno.writeTextFile(
      sdkFile,
      renderGoWorkerSdkSdk({
        protoGenGoImportPath:
          `${GATEWAY_SIDECAR_PROTO_GEN_GO_MODULE_PATH}/sidecargateway/v1`,
      }),
    );
    goFiles.push(sdkFile);
    await Deno.writeTextFile(
      `${dir}/.gitignore`,
      renderGoWorkerSdkGitignore({}),
    );

    // Go's `replace` directives are only honored in the module actually
    // being built, not in a dependency's own `go.mod` — they don't
    // propagate transitively. So even though the aggregate module (below)
    // is what logically imports each actor module, THIS go.mod (the thing
    // actually being built) still needs its own require+replace for every
    // individual actor module the aggregate pulls in, on top of the
    // aggregate's own require+replace, or the build can't resolve them.
    const goActors = actors.filter((a) => a.asyncOperationLanguage === "go");
    const aggregateModulePath = `${appRoot}/${GO_AGGREGATE_DIR_NAME}`;
    const goModContent = renderGoModAggregate({
      moduleName: "pgfsm/async-op-worker-sdk",
      requires: [
        { modulePath: aggregateModulePath },
        ...goActors.map((a) => ({
          modulePath: goActorModulePathFromRegisteredActor(appRoot, a),
        })),
        { modulePath: GATEWAY_SIDECAR_PROTO_GEN_GO_MODULE_PATH },
      ],
      replaces: [
        {
          modulePath: aggregateModulePath,
          target: `./${GO_AGGREGATE_DIR_NAME}`,
        },
        ...goActors.map((a) => ({
          modulePath: goActorModulePathFromRegisteredActor(appRoot, a),
          target: relativeImportDir(
            dir,
            `${writeRootAbsPath}/${ASYNC_WORKER_DIR_NAME}/go/${a.parentFsmName}/${a.parentFsmVersion}/actors/${a.fileBaseName}`,
          ),
        })),
        {
          modulePath: GATEWAY_SIDECAR_PROTO_GEN_GO_MODULE_PATH,
          target: gatewaySidecarProtoGenGoRelPath(dir, repoRootAbsPath),
        },
      ],
    });
    await Deno.writeTextFile(`${dir}/go.mod`, goModContent);
    goModDir = dir;
  }

  return {
    typescript: wroteTypescript,
    python: wrotePython,
    rust: wroteRust,
    go: wroteGo,
    tsFiles,
    rustFiles,
    goFiles,
    goModDir,
  };
}

/**
 * Resolves a plugin-root folder path (relative to `Deno.cwd()`, or already
 * absolute) to an absolute path, and validates it's neither dot-relative nor
 * trailing-slashed. Shared by {@linkcode eachVersionedFsmFolder} and callers
 * that need the plugin root itself (e.g. `generateAsyncOperationLogicFromFolders`'s
 * aggregate registry, written one level above every FSM/version it processes).
 */
export function resolvePluginRootAbsPath(folderPath: string): string {
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
  return folderPath.startsWith("/")
    ? folderPath
    : `${Deno.cwd()}/${folderPath}`;
}

/**
 * The app root — one level above a plugin-root folder, e.g.
 * `apps/fsm-core-example/fsm` -> `apps/fsm-core-example`. Used by
 * `generate-async-logic` (and `generate-all`'s own folder-mode call into it)
 * as the default `worker-sdk-generated/` write destination.
 */
export function oneLevelUp(absPath: string): string {
  return absPath.substring(0, absPath.lastIndexOf("/"));
}

/**
 * Walks a plugin-root folder, finds every versioned FSM subdirectory (e.g.
 * `creditCheck/v01/`) that contains an `fsm.json`, and invokes `handler` with
 * the absolute version-folder path and the parsed fsm.json.
 */
export async function eachVersionedFsmFolder(
  folderPath: string,
  skipDirs: string[],
  handler: (absFolderPath: string, fsmData: FsmMachineJson) => Promise<void>,
): Promise<void> {
  const absFolderPath = resolvePluginRootAbsPath(folderPath);

  for await (const dirEntry of Deno.readDir(absFolderPath)) {
    if (!dirEntry.isDirectory || skipDirs.includes(dirEntry.name)) continue;

    const fsmDirPath = `${absFolderPath}/${dirEntry.name}`;
    for await (const subEntry of Deno.readDir(fsmDirPath)) {
      if (!subEntry.isDirectory) continue;
      if (!isVersionFolderName(subEntry.name)) {
        logger.info("Skipping non-versioned folder: {name} in {dir}", {
          name: subEntry.name,
          dir: fsmDirPath,
        });
        continue;
      }

      const versionFolderPath = `${fsmDirPath}/${subEntry.name}`;
      const fsmJsonPath = `${versionFolderPath}/fsm.json`;
      try {
        const fsmData: FsmMachineJson = JSON.parse(
          await Deno.readTextFile(fsmJsonPath),
        );
        await handler(versionFolderPath, fsmData);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          logger.info("fsm.json is missing in {path}", {
            path: versionFolderPath,
          });
        } else {
          logger.error("Failed to process {path}: {error}", {
            path: fsmJsonPath,
            error: err,
          });
        }
      }
    }
  }
}

/** The shape {@linkcode writeActorsManifest} serializes — read back by {@linkcode collectRegisteredActorsFromAsyncWorkerDir}. */
type ActorManifestEntry = {
  parentFsmName: string;
  parentFsmVersion: string;
  src: string;
  asyncOperationName: string;
  asyncOperationType: RegisteredActor["asyncOperationType"];
  asyncOperationVersion: string;
  asyncOperationLanguage: OperationLang;
  filePath: string;
  exportedAsyncOperationName: string;
};

/**
 * Rebuilds the complete set of {@linkcode RegisteredActor}s actually on disk
 * by walking `<writeRootAbsPath>/async-worker/<lang>/<fsmName>/<fsmVersion>/actors-manifest.json`
 * and reading each one back (#320 gave the manifest every field needed to do
 * this without re-parsing any `fsm.json`) — the source of truth for
 * {@linkcode writeAggregateArtifacts}'s own aggregate registry/worker-SDK
 * writes, replacing the old approach of re-deriving actors by re-walking the
 * *source* FSM tree (`eachVersionedFsmFolder` over `realPluginRootAbsPath`).
 * That re-derivation silently dropped any actor scaffolded under a
 * caller-supplied identity that doesn't match its source `fsm.json`'s own
 * folder path — `generate-async-logic -f <path>/fsm.json --fsm-name
 * <override> --fsm-version <override>` (single-file mode) writes actor files
 * under `<override>/<override>/`, but nothing on the source tree lives at
 * that path, so the re-derivation walk could never rediscover it and the
 * aggregate registry silently never got it. Reading back what was actually
 * written under `async-worker/` instead is correct regardless of any
 * `--fsm-name`/`--fsm-version` override, and also means folder mode's
 * `writeAggregateArtifacts` call no longer needs its caller to have
 * accumulated every `scaffoldAsyncLogicForVersion` return value by hand.
 *
 * Returns `[]` (not an error) when `async-worker/` doesn't exist yet — a
 * fresh `writeRootAbsPath` with nothing written to it yet is a valid state,
 * not a failure, for both callers ({@linkcode
 * generateAsyncOperationLogicFromFolders}/{@linkcode
 * generateAsyncOperationLogicFromFsmJson} in
 * `generate-async-operation-logic.ts`) since this always runs immediately
 * after that same run's own `scaffoldAsyncLogicForVersion` call(s) have
 * already written the directory.
 */
export async function collectRegisteredActorsFromAsyncWorkerDir(
  writeRootAbsPath: string,
): Promise<RegisteredActor[]> {
  const asyncWorkerRoot = `${writeRootAbsPath}/${ASYNC_WORKER_DIR_NAME}`;
  const collected: RegisteredActor[] = [];

  let langEntries: Deno.DirEntry[];
  try {
    langEntries = await Array.fromAsync(Deno.readDir(asyncWorkerRoot));
  } catch (err) {
    if (isNotFoundError(err)) return collected;
    throw err;
  }

  for (const langEntry of langEntries) {
    if (!langEntry.isDirectory) continue;
    const langDir = `${asyncWorkerRoot}/${langEntry.name}`;
    for await (const groupEntry of Deno.readDir(langDir)) {
      // Skips non-directory siblings the aggregate step itself writes into
      // this same `<lang>/` dir (run-async-worker.ts, deno.json,
      // typescript-actors-registry.generated.ts, ...) -- only
      // `<fsmName>/`/`shared-async-op/`-style subdirectories are walked.
      if (!groupEntry.isDirectory) continue;
      const groupDir = `${langDir}/${groupEntry.name}`;
      for await (const versionEntry of Deno.readDir(groupDir)) {
        if (!versionEntry.isDirectory) continue;
        const manifestPath =
          `${groupDir}/${versionEntry.name}/actors-manifest.json`;
        let manifest: { actors: ActorManifestEntry[] };
        try {
          manifest = JSON.parse(await Deno.readTextFile(manifestPath));
        } catch (err) {
          // create-async-logic's shared-async-op/<functionVersion>/ pool has
          // no actors-manifest.json of its own (see that command's own
          // global-registry model) -- skip it, same as any other
          // manifest-less directory this walk happens across.
          if (isNotFoundError(err)) continue;
          throw err;
        }
        for (const entry of manifest.actors) {
          collected.push({
            parentFsmName: entry.parentFsmName,
            parentFsmVersion: entry.parentFsmVersion,
            src: entry.src,
            fileBaseName: actorFileBaseName({ src: entry.src }),
            asyncOperationLanguage: entry.asyncOperationLanguage,
            filePath: entry.filePath,
            exportedName: entry.exportedAsyncOperationName,
            asyncOperationType: entry.asyncOperationType,
            asyncOperationName: entry.asyncOperationName,
            asyncOperationVersion: entry.asyncOperationVersion,
          });
        }
      }
    }
  }

  return collected;
}
