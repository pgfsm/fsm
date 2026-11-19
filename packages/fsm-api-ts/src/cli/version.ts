// Swapped for ./version.node.ts in the npm/npx build (generated at build time
// by scripts/build-npm.ts, not committed: the version differs per release),
// as in @pgfsm/async-worker-gateway. This is the Deno-native default: reads
// deno.json's version field directly (the image's `deno compile` includes it).
const denoJson = JSON.parse(
  await Deno.readTextFile(new URL("../../deno.json", import.meta.url)),
);
export const PACKAGE_VERSION: string = denoJson.version;
