import { copy } from "@std/fs/copy";
import { basename, join } from "@std/path";

/** Directories a dry run never needs: VCS metadata and toolchain caches/builds. */
const SKIP = new Set([".git", "node_modules", "target", ".venv", "dist"]);

/**
 * Runs `fn` against a throwaway copy of `root` (an empty directory when
 * `root` doesn't exist yet, as for `create`), so `--dry-run` can go through exactly the same
 * code path as a real run -- the compiler has no "plan only" mode -- and
 * report what it would do without touching the real tree. The copy is
 * always removed.
 */
export async function inSandbox<T>(
  root: string,
  fn: (sandboxRoot: string) => Promise<T>,
): Promise<T> {
  const base = await Deno.makeTempDir({ prefix: "pgfsm-dry-run-" });
  // Same directory name as the real root: the compiler derives the Go
  // module root from it, so the plan matches a real run.
  const sandboxRoot = join(base, basename(root));
  try {
    await Deno.mkdir(sandboxRoot);
    if (await isDir(root)) {
      for await (const entry of Deno.readDir(root)) {
        if (SKIP.has(entry.name)) continue;
        await copy(join(root, entry.name), join(sandboxRoot, entry.name));
      }
    }
    return await fn(sandboxRoot);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}
