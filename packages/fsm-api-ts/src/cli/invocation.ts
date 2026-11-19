// Swapped for ./invocation.node.ts in the npm/npx build via build-npm.ts's
// `mappings` option (Deno runtime detection isn't reliable there: dnt's
// shims provide a Deno global under Node too). The Deno-native default.
export const CLI_INVOCATION = "deno run --allow-all src/cli/index.ts";
