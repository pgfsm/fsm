// Swapped for ./gateway-invocation.node.ts in the npm/npx build via
// build-npm.ts's `mappings` option — Deno runtime detection isn't reliable
// here (dnt's `shims: { deno: true }` provides a Deno global under Node
// too), same as fsm-compiler-ts's invocation.ts (#254/#258). This is the
// Deno-native default.
export const CLI_INVOCATION =
  "deno run --allow-all src/cli/async-operation-worker-gateway.ts";
