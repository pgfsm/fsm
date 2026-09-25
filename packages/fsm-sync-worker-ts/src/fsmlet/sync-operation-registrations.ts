import { getLogger } from "@logtape/logtape";
import { extractFsmPluginRefs } from "@pgfsm/compiler";
import type { FsmPluginValidationResult } from "@pgfsm/compiler";
import type { SyncOperationRegistration } from "./type.ts";

// FsmMachineJson isn't part of @pgfsm/compiler's public export surface (only
// FsmPluginValidationResult is) -- indexed access gets the same underlying
// type structurally without needing to import it by name.
type FsmMachineJson = NonNullable<
  FsmPluginValidationResult["fsmJsonConfigData"]
>;

const logger = getLogger(["@pgfsm/fsmlet", "sync-operation-registrations"]);

// generate-sync-logic always writes both the aggregate registry and each
// <fsmName>/<fsmVersion>'s own fsm.json copy under {cwd}/sync-worker/typescript/,
// independent of the source FSM tree's own location -- see fsm-compiler-ts's
// generate-sync-operation-logic.ts / operation-logic-scaffold.ts (#338).
const SYNC_WORKER_TYPESCRIPT_DIR = () => `${Deno.cwd()}/sync-worker/typescript`;
const AGGREGATE_SYNC_OPERATION_REGISTRY_PATH = () =>
  `${SYNC_WORKER_TYPESCRIPT_DIR()}/aggregate-generated-sync-operation-registry.ts`;

/**
 * Dynamically imports the compiler-generated aggregate sync-operation
 * registry and returns every registration across every `<fsmName>/<fsmVersion>`
 * this project has generated. Returns `undefined` when the aggregate can't be
 * loaded (e.g. `generate-sync-logic` was never run, or produced no
 * registrations at all) — a real failure, distinct from a since-filtered
 * empty array for one FSM (see {@linkcode syncOperationRegistrationsFor}),
 * which just means that FSM legitimately has no actions/guards/delays.
 */
export async function loadAllSyncOperationRegistrations(): Promise<
  SyncOperationRegistration[] | undefined
> {
  const path = AGGREGATE_SYNC_OPERATION_REGISTRY_PATH();
  try {
    const mod = await import(`file://${path}`) as {
      SYNC_OPERATION_REGISTRATIONS: SyncOperationRegistration[];
    };
    return mod.SYNC_OPERATION_REGISTRATIONS;
  } catch (err) {
    logger.warning(
      "Could not load aggregate sync-operation registry from {path}: {error}",
      { path, error: err },
    );
    return undefined;
  }
}

/** The sub-array of `registrations` belonging to one `<fsmName>/<fsmVersion>`. */
export function syncOperationRegistrationsFor(
  registrations: SyncOperationRegistration[],
  fsmName: string,
  fsmVersion: string,
): SyncOperationRegistration[] {
  return registrations.filter((r) =>
    r.fsmName === fsmName && r.fsmVersion === fsmVersion
  );
}

/** Every distinct `<fsmName>/<fsmVersion>` pair present across `registrations`, first-seen order. */
function distinctFsmGroups(
  registrations: SyncOperationRegistration[],
): { fsmName: string; fsmVersion: string }[] {
  const seen = new Set<string>();
  const groups: { fsmName: string; fsmVersion: string }[] = [];
  for (const r of registrations) {
    const key = `${r.fsmName}/${r.fsmVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push({ fsmName: r.fsmName, fsmVersion: r.fsmVersion });
  }
  return groups;
}

/**
 * Reads the `fsm.json` copy `generate-sync-logic` writes alongside each
 * `<fsmName>/<fsmVersion>`'s own `generated-sync-operation-registry.ts` (see
 * fsm-compiler-ts's `scaffoldSyncLogicForVersion`). Returns `undefined` if
 * missing/unreadable.
 */
async function loadFsmJsonForGroup(
  fsmName: string,
  fsmVersion: string,
): Promise<FsmMachineJson | undefined> {
  const path =
    `${SYNC_WORKER_TYPESCRIPT_DIR()}/${fsmName}/${fsmVersion}/fsm.json`;
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch (err) {
    logger.warning(
      "Could not read fsm.json copy for {fsmName}/{fsmVersion} at {path}: {error}",
      { fsmName, fsmVersion, path, error: err },
    );
    return undefined;
  }
}

type DiscoverFilter =
  | { mode: "all"; skipFsmNames?: string[] }
  | { mode: "single"; fsmName: string; fsmVersion: string };

/**
 * Builds the fsmlet's verified-FSM-module list directly from the
 * compiler-generated sync-worker output, replacing the old
 * `validateSyncOperationFromFsmJson`/`validateSyncOperationFromFolders`
 * dynamic-import + AJV schema-validation pass (see fsm-sync-worker-ts #340).
 * Trusts the compiler's own output: any `<fsmName>/<fsmVersion>` present in
 * the aggregate registry, with a readable `fsm.json` copy, is considered
 * verified — `generate-sync-logic` is what guarantees the registered
 * handlers actually exist, not this process, so there's no re-validation via
 * dynamic import here (deliberately no AJV schema check either, for the same
 * reason — this package now only ever consumes already-compiled output).
 *
 * `filter.mode: "all"` returns every group in the aggregate (fsmlet's folder
 * mode — `skipFsmNames` mirrors the old `skipDirs`, filtered by `fsmName`
 * since that's what a plugin-root folder name became once compiled).
 * `filter.mode: "single"` narrows to exactly one `<fsmName>/<fsmVersion>`
 * (fsmlet's single-fsm.json mode).
 *
 * Still returns `FsmPluginValidationResult[]` (the `@pgfsm/compiler` type the
 * rest of `fsmlet.ts` already threads through `loadFsmFromJson`,
 * `checkRegistryForAsyncActors`, `registerFsmlet`, etc.) to keep those
 * downstream steps unchanged — `fsmAbsFolderPath`/`fsmModuleDefinition`/
 * `failedMethods` are populated with best-effort placeholders since they're
 * no longer meaningful once module resolution and validation both live in
 * the compiler, not here.
 */
export async function discoverVerifiedFsmModules(
  filter: DiscoverFilter,
): Promise<FsmPluginValidationResult[]> {
  const allRegistrations = await loadAllSyncOperationRegistrations();
  if (!allRegistrations) return [];

  const groups = filter.mode === "single"
    ? [{ fsmName: filter.fsmName, fsmVersion: filter.fsmVersion }]
    : distinctFsmGroups(allRegistrations).filter((g) =>
      !(filter.skipFsmNames ?? []).includes(g.fsmName)
    );

  const results: FsmPluginValidationResult[] = [];
  for (const { fsmName, fsmVersion } of groups) {
    const fsmJsonConfigData = await loadFsmJsonForGroup(fsmName, fsmVersion);
    if (!fsmJsonConfigData) continue;

    const { actors: asyncOperationActors } = extractFsmPluginRefs(
      fsmJsonConfigData,
    );
    const groupPath =
      `${SYNC_WORKER_TYPESCRIPT_DIR()}/${fsmName}/${fsmVersion}`;

    results.push({
      src: fsmName,
      fsmName,
      fsmVersion,
      fsmAbsFolderPath: groupPath,
      fsmRelativeFolderPath: `${fsmName}/${fsmVersion}`,
      fsmParentDirName: "typescript",
      fsmParentAbsFolderPath: SYNC_WORKER_TYPESCRIPT_DIR(),
      fsmParentRelativeFolderPath: "sync-worker/typescript",
      fsmJsonPresent: true,
      fsmJsonConfigData,
      fsmJsonFollowSchema: true,
      isFsmModuleVerified: true,
      fsmModuleDefinition: null,
      failedMethods: [],
      asyncOperationActors,
    });
  }
  return results;
}
