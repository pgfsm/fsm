// fsm_core's installed version (SPEC-016, #688). The API, fsmlet and gateway
// call requireFsmCoreVersion() once at startup, so a process that's newer or
// older than its database fails at once, naming both versions and the
// upgrade scripts to apply, instead of failing later on a missing function.

/**
 * The oldest fsm_core this @pgfsm/db works with. Raise it when this package
 * starts calling SQL that a newer fsm_core adds; fsm_core of a later major
 * version is refused too (a major bump means a breaking SQL change).
 */
export const FSM_CORE_MIN_VERSION = "2.3.0";

/** A pg Pool or PoolClient: anything that runs a parameterless query. */
export interface FsmCoreQueryable {
  query<R>(sql: string): Promise<{ rows: R[] }>;
}

function parse(v: string): [number, number, number] {
  const [a, b, c] = v.split(".").map(Number);
  return [a, b, c];
}

function compare(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * fsm_core.version(), or null for an fsm_core older than 2.3.0 (which had no
 * version()). Throws when fsm_core isn't installed at all.
 */
export async function getFsmCoreVersion(
  db: FsmCoreQueryable,
): Promise<string | null> {
  const res = await db.query<{ installed: boolean; has_version: boolean }>(
    `SELECT to_regnamespace('fsm_core') IS NOT NULL AS installed,
            to_regprocedure('fsm_core.version()') IS NOT NULL AS has_version`,
  );
  const { installed, has_version } = res.rows[0];
  if (!installed) {
    throw new FsmCoreVersionError(
      "fsm_core isn't installed in this database: run the full install, fsm_core--<version>.sql (packages/database-src/README.md)",
      null,
    );
  }
  if (!has_version) return null;
  const v = await db.query<{ version: string }>(
    "SELECT fsm_core.version() AS version",
  );
  return v.rows[0].version;
}

export class FsmCoreVersionError extends Error {
  constructor(message: string, readonly found: string | null) {
    super(message);
    this.name = "FsmCoreVersionError";
  }
}

/**
 * Returns the installed fsm_core version when `component` can run on it:
 * at least `min`, with the same major version. Otherwise throws a
 * FsmCoreVersionError naming the found and required versions and the
 * upgrade scripts to apply (or, for a database that's ahead, the release to
 * upgrade `component` to).
 */
export async function requireFsmCoreVersion(
  db: FsmCoreQueryable,
  component: string,
  min: string = FSM_CORE_MIN_VERSION,
): Promise<string> {
  const found = await getFsmCoreVersion(db);
  const major = parse(min)[0];
  const range = `>= ${min} and < ${major + 1}.0.0`;
  if (found === null) {
    throw new FsmCoreVersionError(
      `${component} needs fsm_core ${range}, found a version before 2.3.0 (no fsm_core.version()): apply the upgrade scripts fsm_core--<installed>--<next>.sql in order, up to ${min}`,
      null,
    );
  }
  if (compare(found, min) < 0) {
    throw new FsmCoreVersionError(
      `${component} needs fsm_core ${range}, found ${found}: apply the upgrade scripts in order, from fsm_core--${found}--<next>.sql up to ${min}`,
      found,
    );
  }
  if (parse(found)[0] > major) {
    throw new FsmCoreVersionError(
      `${component} needs fsm_core ${range}, found ${found}: upgrade ${component} to a release that supports fsm_core ${
        parse(found)[0]
      }.x`,
      found,
    );
  }
  return found;
}
