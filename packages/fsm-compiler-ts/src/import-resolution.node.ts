// npm/npx build variant of ./import-resolution.ts (see build-npm.ts's
// `mappings` option, and #270). Under plain Node.js, a dynamic import() of
// an arbitrary target file (e.g. a user's machine.ts) resolves that file's
// own bare specifiers by walking node_modules/ upward from the TARGET
// file's own path — never from wherever @pgfsm/compiler itself is
// installed. Most FSM trees in this repo have no node_modules of their own
// (they rely on a Deno import map instead), so those imports fail under the
// npm/npx build even though the exact same file works under `deno run`.
//
// This registers a Node module resolution hook (./cli/loader.node.ts) that
// falls back to reading the target file's own deno.json import map and
// resolving `npm:`-mapped bare specifiers itself, on demand, only when
// Node's normal resolution has already failed. See loader.node.ts for the
// actual algorithm and its documented scope limits.
import { register } from "node:module";

let registered = false;

export function ensureImportMapResolution(): Promise<void> {
  if (!registered) {
    registered = true;
    register(
      new URL("./cli/loader.node.js", import.meta.url).href,
      import.meta.url,
    );
  }
  return Promise.resolve();
}
