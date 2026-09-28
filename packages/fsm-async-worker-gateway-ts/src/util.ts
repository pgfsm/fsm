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

/** Default grace period for {@link closeHttp2Server}. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

/**
 * Records every HTTP/2 session `server` accepts, for
 * {@link closeHttp2Server}. Call right after creating the server.
 */
export function trackHttp2Sessions(
  server: import("node:http2").Http2Server,
): Set<import("node:http2").ServerHttp2Session> {
  const sessions = new Set<import("node:http2").ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  return sessions;
}

/**
 * Closes `server` without waiting forever on clients (#397). `server.close()`
 * alone only stops accepting connections and then waits for every existing
 * HTTP/2 session to end — which a client that keeps its connection open (a
 * worker's long-lived Session stream, a pooled Connect client) never does.
 * This sends GOAWAY on each open session so in-flight streams can finish,
 * then destroys whatever is still open after `graceMs`.
 */
export function closeHttp2Server(
  server: import("node:http2").Http2Server,
  sessions: Set<import("node:http2").ServerHttp2Session>,
  graceMs: number = DEFAULT_SHUTDOWN_GRACE_MS,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      for (const session of sessions) session.destroy();
    }, graceMs);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    for (const session of sessions) session.close();
  });
}
