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

/** @pgfsm/ctl, for the `db:pgcron` script. */
export const CTL_VERSION: string = await siblingVersion("fsm-ctl-ts");
/** @pgfsm/async-worker-gateway, for the `gateway` script. */
export const GATEWAY_VERSION: string = await siblingVersion(
  "fsm-async-worker-gateway-ts",
);
