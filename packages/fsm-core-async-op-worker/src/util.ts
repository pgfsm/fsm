/**
 * True when `error` represents a "path does not exist" failure from a Deno
 * filesystem call, under BOTH the real Deno runtime and the npm/npx build.
 *
 * Real Deno throws a genuine `Deno.errors.NotFound` for a missing path, so
 * `instanceof` alone is enough there. Under the npm/npx build, `Deno.remove`/
 * `Deno.removeSync` are `@deno/shim-deno`'s implementations — and unlike its
 * `stat`/`lstat`/`readTextFile`/`readDir` (which correctly map Node's raw
 * `fs` errors into real `Deno.errors.*` instances via an internal
 * `errorMap`), `remove`/`removeSync` do not: a missing path rethrows the raw
 * Node `fs.rm`/`fs.rmSync` error unwrapped — a plain `Error` with
 * `.code === "ENOENT"`, never an instance of `Deno.errors.NotFound`. An
 * `instanceof`-only check therefore silently breaks any "ignore missing
 * path, it's fine" cleanup logic built on `Deno.remove`/`Deno.removeSync`
 * once built for npm/npx — see #278.
 */
export function isNotFoundError(error: unknown): boolean {
  if (error instanceof Deno.errors.NotFound) return true;
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}
