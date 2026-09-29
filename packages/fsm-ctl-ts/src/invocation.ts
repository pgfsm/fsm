// Swapped for ./invocation.node.ts in the npm/npx build: help text shows how
// to invoke pgfsmctl, which differs between this Deno source and the
// published package. Runtime detection doesn't work under dnt's shims (see
// fsm-compiler-ts's build-npm.ts, #254/#258), so the whole module is
// swapped instead. This is the Deno-native default.
export const CLI_INVOCATION = "deno task pgfsmctl";
