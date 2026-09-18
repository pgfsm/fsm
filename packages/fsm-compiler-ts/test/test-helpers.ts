/**
 * Like Deno.makeTempDir(), but creates the directory inside this package's
 * own tree instead of the OS temp dir. Deno's workspace-driven import-map
 * resolution for bare/npm specifiers (e.g. a copied machine.ts's "xstate"
 * import) only applies to files under the workspace root recognized at
 * process startup — a fixture copied under the OS temp dir sits outside that
 * tree, so the first dynamic import of a given bare specifier from such a
 * copy fails with "not a dependency and not in import map" (see #214). Any
 * fixture that dynamically imports a copied machine.ts (directly, or via
 * generateFsmJSONFromMachineFile/generateFsmJSONFromFolders) must live under
 * this instead of a plain Deno.makeTempDir().
 *
 * Assumes the process cwd is the repo root, matching every other absolute
 * path built in these test files (e.g. cli.test.ts's own `CLI` constant).
 */
export async function makeWorkspaceTempDir(prefix: string): Promise<string> {
  const dir =
    `${Deno.cwd()}/packages/fsm-compiler-ts/.test-fixtures/${prefix}-${crypto.randomUUID()}`;
  await Deno.mkdir(dir, { recursive: true });
  return dir;
}
