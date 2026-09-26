// Swapped for ./gateway-ctl-invocation.node.ts in the npm/npx build via
// build-npm.ts's `mappings` option — see gateway-invocation.ts for why
// runtime detection isn't used instead. This is the Deno-native default.
export const CLI_INVOCATION =
  "deno run --allow-all src/cli/async-operation-worker-gateway-ctl.ts";
