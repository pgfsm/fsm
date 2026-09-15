import { loadFsmJSONFromFolders } from "@pgfsm/compiler";
import type { DBDeps } from "@pgfsm/db";

export const FIXTURE_FSM_NAME = "vitalsWorkflow";
export const FIXTURE_FSM_VERSION = "v01";

// vitalsWorkflow/v01 is the simplest standalone example FSM (no child-FSM
// invoke dependency, unlike carVitals which invokes it) — see
// apps/fsm-core-example/fsm/. Skip the other example FSMs so a stress run
// doesn't pay to load fixtures it doesn't use.
const OTHER_EXAMPLE_FSMS = ["carVitals", "creditCheck", "taskMachineConfig"];

// loadFsmJSONFromFolders resolves a relative folderPath against Deno.cwd()
// (packages/database-src when run via `deno task stress`), but the example
// FSMs live under apps/fsm-core-example at the repo root — outside that cwd
// — so an absolute path is required. Resolve it from this file's own
// location instead of relying on cwd.
const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;
const EXAMPLE_FSM_DIR = `${REPO_ROOT}apps/fsm-core-example/fsm`;

/**
 * Loads vitalsWorkflow/v01 into fsm_core if it isn't already present.
 * load_fsm_from_json_v2 is idempotent for identical content (it short-
 * circuits), so this is safe to call at the start of every run.
 */
export async function ensureFixtureLoaded(deps: DBDeps): Promise<void> {
  await loadFsmJSONFromFolders(
    EXAMPLE_FSM_DIR,
    "fsm",
    OTHER_EXAMPLE_FSMS,
    deps,
  );
}
