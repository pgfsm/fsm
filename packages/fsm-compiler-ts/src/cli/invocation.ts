// Swapped for ./invocation.node.ts in the npm/npx build via build-npm.ts's
// `mappings` option — Deno runtime detection isn't reliable here, since
// dnt's `shims: { deno: true }` provides a Deno global under Node too (see
// #254). This is the Deno-native default: help text run via `deno task cli`
// should show the `deno run` invocation.
export const CLI_INVOCATION = "deno run --allow-all src/cli/index.ts";
