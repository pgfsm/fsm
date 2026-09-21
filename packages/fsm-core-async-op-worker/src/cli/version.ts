// Swapped for ./version.node.ts in the npm/npx build (generated at build
// time by build-npm.ts, not committed — the version differs per release —
// see #262, mirroring fsm-compiler-ts's version.ts from #258). This is the
// Deno-native default: reads deno.json's version field directly.
const denoJson = JSON.parse(
  await Deno.readTextFile(new URL("../../deno.json", import.meta.url)),
);
export const PACKAGE_VERSION: string = denoJson.version;
