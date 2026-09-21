// Swapped for ./import-resolution.node.ts in the npm/npx build via
// build-npm.ts's `mappings` option (see #270, and the same pattern already
// used for src/cli/invocation.ts / invocation.node.ts). Deno's own module
// resolution already honors the target FSM tree's deno.json import map
// (e.g. "xstate": "npm:xstate@^5.28.0") for any file it dynamically
// imports, regardless of where that file lives relative to the process
// invoking it — so there is nothing to do here under Deno.
export async function ensureImportMapResolution(): Promise<void> {}
