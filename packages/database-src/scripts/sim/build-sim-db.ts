// Turns a migrated fsm_core database into a simulation database, in place
// (SPEC-015 §2, #643). The deterministic simulator runs the real SQL on virtual
// time, which only works if every clock read goes through fsm_core.tx_now() /
// fsm_core.wall_now(). Our own SQL already does (#642, enforced by
// scripts/check-sql-clock-seams.ts). pgmq doesn't, and stays pristine: it is
// the pgmq extension Postgres has installed (00_pre_ext only runs
// CREATE EXTENSION pgmq; the vendored PGMQ_source.sql is commented-out
// reference). So this script rewrites the installed extension's functions and
// the pgmq tables' column defaults in the target database, whatever pgmq
// version that is. Nothing in the repo or in production is edited.
//
// It also unschedules the pg_cron scheduler job: in a simulation the simulator
// calls fsm_core.schedule_all_pending() as an explicit step, so the seed
// decides when it fires.
//
// pgmq.read_with_poll() loops until wall_now() passes a deadline, so on frozen
// virtual time it never returns. Nothing in the repo calls it; the simulator
// must not either.
//
// Usage (from packages/database-src, local Supabase running):
//   deno task sim:db:build                  # DATABASE_URL from ../../.env
//   deno task sim:db:build --db-url=postgresql://…
// It changes the target database; `npm run supabase:db:reset` undoes it. A
// non-local host is refused unless --allow-remote is passed: unscheduling the
// cron job on a real deployment would stop instances being scheduled.

// @ts-types="@types/pg"
import type { ClientBase } from "pg";

/**
 * Rewrites zero-argument now() and clock_timestamp() calls to the seams. The
 * lookbehind leaves qualified and longer names alone (fsm_core.tx_now(),
 * pg_catalog.now()), so the rewrite is idempotent. Other clock forms
 * (current_timestamp, 'now', statement_timestamp()…) are deliberately not
 * handled: pgmq doesn't use them today, and the test fails if a pgmq bump
 * starts to, rather than this guessing at a rewrite.
 */
export function rewriteClockCalls(sql: string): string {
  return sql
    .replace(/(?<![.\w])now\s*\(\s*\)/gi, "fsm_core.tx_now()")
    .replace(/(?<![.\w])clock_timestamp\s*\(\s*\)/gi, "fsm_core.wall_now()");
}

export interface SimBuildReport {
  /** pgmq functions whose bodies were rewritten, as regprocedure text. */
  functions: string[];
  /** pgmq column defaults that were rewritten, as schema.table.column. */
  defaults: string[];
  /** Roles granted EXECUTE on the seams because they can use pgmq. */
  grants: string[];
  /** pg_cron job names unscheduled. */
  cronJobs: string[];
}

// pgmq's functions: the extension's members plus anything else in its schema.
export const PGMQ_FUNCTIONS = `
  SELECT p.oid::regprocedure::text AS sig, pg_get_functiondef(p.oid) AS def
  FROM pg_proc p
  WHERE p.prokind = 'f'
    AND (p.pronamespace = 'pgmq'::regnamespace
      OR EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
                 WHERE d.objid = p.oid AND d.deptype = 'e' AND e.extname = 'pgmq'))
  ORDER BY 1`;

// Column defaults on pgmq's tables (meta, and every queue's q_ / a_ table).
export const PGMQ_DEFAULTS = `
  SELECT format('%s.%s.%s', n.nspname, c.relname, a.attname) AS col,
         format('ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT ',
                n.nspname, c.relname, a.attname) AS alter_prefix,
         pg_get_expr(d.adbin, d.adrelid) AS expr
  FROM pg_attrdef d
  JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
  JOIN pg_class c ON c.oid = d.adrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'pgmq'
  ORDER BY 1`;

/**
 * Applies the simulation build on `client`. It doesn't open or commit a
 * transaction: the CLI wraps it in one, the tests roll it back.
 */
export async function buildSimDb(client: ClientBase): Promise<SimBuildReport> {
  const seams = await client.query(
    `SELECT to_regprocedure('fsm_core.tx_now()') IS NOT NULL
        AND to_regprocedure('fsm_core.wall_now()') IS NOT NULL AS ok`,
  );
  if (!seams.rows[0].ok) {
    throw new Error(
      "fsm_core.tx_now() / wall_now() not found: the sim build needs fsm_core >= 2.2.0 (#642)",
    );
  }

  const report: SimBuildReport = {
    functions: [],
    defaults: [],
    grants: [],
    cronJobs: [],
  };

  const fns = await client.query<{ sig: string; def: string }>(PGMQ_FUNCTIONS);
  for (const { sig, def } of fns.rows) {
    const rewritten = rewriteClockCalls(def);
    if (rewritten === def) continue;
    // pg_get_functiondef gives a CREATE OR REPLACE that keeps the function's
    // OID, owner and extension membership.
    await client.query(rewritten);
    report.functions.push(sig);
  }

  const defaults = await client.query<
    { col: string; alter_prefix: string; expr: string }
  >(PGMQ_DEFAULTS);
  for (const { col, alter_prefix, expr } of defaults.rows) {
    const rewritten = rewriteClockCalls(expr);
    if (rewritten === expr) continue;
    await client.query(alter_prefix + rewritten);
    report.defaults.push(col);
  }

  // pgmq's functions are SECURITY INVOKER, so whoever calls them now calls the
  // seams too. fsm_worker already has EXECUTE (#642); this covers the rest.
  const roles = await client.query<{ rolname: string; stmt: string }>(
    `SELECT r.rolname,
            format('GRANT EXECUTE ON FUNCTION fsm_core.tx_now(), fsm_core.wall_now() TO %I',
                   r.rolname) AS stmt
     FROM pg_roles r
     WHERE r.rolname !~ '^pg_'
       AND has_schema_privilege(r.oid, 'pgmq', 'USAGE')
       AND NOT (has_function_privilege(r.oid, 'fsm_core.tx_now()', 'EXECUTE')
            AND has_function_privilege(r.oid, 'fsm_core.wall_now()', 'EXECUTE'))
     ORDER BY 1`,
  );
  for (const { rolname, stmt } of roles.rows) {
    await client.query(stmt);
    report.grants.push(rolname);
  }

  // Matched on the command, not the name, so a job registered under another
  // name (pgfsmctl db cron register --name …) is caught too.
  const hasCron = await client.query(
    `SELECT to_regclass('cron.job') IS NOT NULL AS ok`,
  );
  if (hasCron.rows[0].ok) {
    const jobs = await client.query<{ jobid: string; jobname: string }>(
      `SELECT jobid, jobname FROM cron.job
       WHERE command ILIKE '%fsm_core.schedule_all_pending%' ORDER BY jobid`,
    );
    for (const { jobid, jobname } of jobs.rows) {
      await client.query(`SELECT cron.unschedule($1::bigint)`, [jobid]);
      report.cronJobs.push(jobname);
    }
  }

  return report;
}

function parseFlags(args: string[]): { dbUrl?: string; allowRemote: boolean } {
  let dbUrl: string | undefined;
  let allowRemote = false;
  for (const arg of args) {
    if (arg === "--allow-remote") allowRemote = true;
    else if (arg.startsWith("--db-url=")) dbUrl = arg.slice("--db-url=".length);
    else throw new Error(`Unrecognized argument: ${arg}`);
  }
  return { dbUrl, allowRemote };
}

async function main() {
  const flags = parseFlags(Deno.args);
  const dotenv = await import("dotenv");
  // Relative to the deno task's cwd (packages/database-src), as in scripts/stress/db.ts.
  dotenv.config({ path: "../../.env" });
  const dbUrl = flags.dbUrl ?? Deno.env.get("DATABASE_URL");
  if (!dbUrl) {
    throw new Error(
      "Pass --db-url=… or set DATABASE_URL (run from packages/database-src to pick up ../../.env).",
    );
  }
  const host = new URL(dbUrl).hostname;
  if (
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) &&
    !flags.allowRemote
  ) {
    throw new Error(
      `Refusing to build a sim database on ${host}: it unschedules the scheduler's ` +
        `pg_cron job. Pass --allow-remote if this really is a throwaway database.`,
    );
  }

  // @ts-types="@types/pg"
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const report = await buildSimDb(client);
    await client.query("COMMIT");
    console.log(`sim database build applied to ${host}:`);
    console.log(
      `  pgmq functions rewritten: ${report.functions.join(", ") || "none"}`,
    );
    console.log(
      `  pgmq defaults rewritten:  ${report.defaults.join(", ") || "none"}`,
    );
    console.log(
      `  seam grants added:        ${report.grants.join(", ") || "none"}`,
    );
    console.log(
      `  cron jobs unscheduled:    ${report.cronJobs.join(", ") || "none"}`,
    );
    console.log("Undo with `npm run supabase:db:reset`.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  await main();
}
