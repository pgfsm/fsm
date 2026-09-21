// Swapped for ./fsmlet-invocation.node.ts in the npm/npx build via
// build-npm.ts's `mappings` option — Deno runtime detection isn't reliable
// here, same as fsm-compiler-ts's invocation.ts (#254) and
// fsm-core-async-op-worker's gateway-invocation.ts (#262). This is the
// Deno-native default.
export const CLI_INVOCATION = "deno run --allow-all src/cli/fsmlet.ts";
