// Versions of the sibling tools `create` pins in a project's npm scripts
// (SPEC-005): the ones this @pgfsm/cli was built and tested against.
// Swapped for ./tool-versions.node.ts in the npm/npx build (generated at
// build time by scripts/build-npm.ts, not committed), like ./version.ts.
// This is the Deno-native default: reads each sibling package's deno.json in
// this monorepo checkout.
async function siblingVersion(packageDir: string): Promise<string> {
  const denoJson = JSON.parse(
    await Deno.readTextFile(
      new URL(`../../${packageDir}/deno.json`, import.meta.url),
    ),
  );
  return denoJson.version;
}

/** @pgfsm/ctl, for the `db:load` script. */
export const CTL_VERSION: string = await siblingVersion("fsm-ctl-ts");
/** @pgfsm/api, for the `api` and `api:key` scripts (SPEC-016). */
export const API_VERSION: string = await siblingVersion("fsm-api-ts");
/** @pgfsm/async-worker-gateway, for the `gateway` script. */
export const GATEWAY_VERSION: string = await siblingVersion(
  "fsm-async-worker-gateway-ts",
);

/**
 * fsm_core, for the generated db/Dockerfile (SPEC-016): the newest
 * `fsm_core--<from>--<to>.sql` migration in this checkout, i.e. the schema
 * this @pgfsm/cli was built against.
 */
async function newestFsmCoreVersion(): Promise<string> {
  const dir = new URL(
    "../../database-src/supabase/migrations/",
    import.meta.url,
  );
  let newest: number[] | null = null;
  for await (const e of Deno.readDir(dir)) {
    const m = e.name.match(/_fsm_core--(?:[\d.]+--)?(\d+)\.(\d+)\.(\d+)\.sql$/);
    if (!m) continue;
    const v = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (
      newest === null ||
      v[0] > newest[0] || (v[0] === newest[0] && v[1] > newest[1]) ||
      (v[0] === newest[0] && v[1] === newest[1] && v[2] > newest[2])
    ) newest = v;
  }
  if (newest === null) throw new Error(`no fsm_core migration in ${dir}`);
  return newest.join(".");
}

/** fsm_core, for db/Dockerfile's FSM_CORE_VERSION (SPEC-016). */
export const FSM_CORE_VERSION: string = await newestFsmCoreVersion();
