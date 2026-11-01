// The sim database build (SPEC-015 §2, #643). The rewrite tests run anywhere;
// the database tests need DATABASE_URL (CI's Database job) and run inside a
// transaction they roll back, so the shared local database is never left as a
// sim database.

import { assert, assertEquals } from "@std/assert";
// @ts-types="@types/pg"
import { Pool, type PoolClient } from "pg";
import { rawClockReads } from "../../../../scripts/check-sql-clock-seams.ts";
import {
  buildSimDb,
  PGMQ_DEFAULTS,
  PGMQ_FUNCTIONS,
  rewriteClockCalls,
} from "./build-sim-db.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const integration = { ignore: !DATABASE_URL, sanitizeResources: false };

Deno.test("rewriteClockCalls moves now() and clock_timestamp() to the seams", () => {
  assertEquals(
    rewriteClockCalls(
      "vt = clock_timestamp() + %L, enqueued_at DEFAULT now(), NOW() as t, CLOCK_TIMESTAMP ( )",
    ),
    "vt = fsm_core.wall_now() + %L, enqueued_at DEFAULT fsm_core.tx_now(), " +
      "fsm_core.tx_now() as t, fsm_core.wall_now()",
  );
});

Deno.test("rewriteClockCalls leaves seams and qualified or longer names alone", () => {
  const sql =
    "fsm_core.tx_now(), fsm_core.wall_now(), pg_catalog.now(), snow(), my_clock_timestamp()";
  assertEquals(rewriteClockCalls(sql), sql);
});

Deno.test("rewriteClockCalls is idempotent", () => {
  const once = rewriteClockCalls("select now(), clock_timestamp()");
  assertEquals(rewriteClockCalls(once), once);
});

async function inRolledBackTxn(fn: (c: PoolClient) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
}

Deno.test({
  name:
    "after the sim build no pgmq function or default reads the clock directly",
  ...integration,
  fn: () =>
    inRolledBackTxn(async (c) => {
      // A queue, so the per-queue q_ / a_ tables' defaults are covered too.
      await c.query(`SELECT pgmq.create('sim_build_test_defaults')`);
      const report = await buildSimDb(c);
      assert(report.functions.length > 0, "expected pgmq functions to rewrite");

      // The pgmq-bump guard: any clock form the rewrite doesn't handle shows
      // up here, with the same patterns as the fsm_core lint.
      const left: string[] = [];
      for (const { sig, def } of (await c.query(PGMQ_FUNCTIONS)).rows) {
        for (const { match } of rawClockReads(def, false)) {
          left.push(`${sig}: ${match}`);
        }
      }
      for (const { col, expr } of (await c.query(PGMQ_DEFAULTS)).rows) {
        for (const { match } of rawClockReads(expr, false)) {
          left.push(`${col}: ${match}`);
        }
      }
      assertEquals(
        left,
        [],
        "raw clock reads left in pgmq after the sim build",
      );
    }),
});

Deno.test({
  name: "after the sim build pgmq visibility follows virtual time",
  ...integration,
  fn: () =>
    inRolledBackTxn(async (c) => {
      await buildSimDb(c);
      // By name: GRANT … TO CURRENT_USER segfaults the backend on Supabase PG 15.8.
      await c.query(
        `DO $$ BEGIN EXECUTE format('GRANT fsm_sim TO %I', session_user); END $$`,
      );
      const setNow = (t: string) =>
        c.query(`SELECT set_config('fsm_core.sim_now', $1, true)`, [t]);
      await c.query(`SELECT pgmq.create('sim_build_test_vt')`);

      await setNow("2030-01-01 00:00:00+00");
      // Send, then look the row up: a join in the same statement wouldn't see
      // the row send() inserts.
      await c.query(`SELECT pgmq.send('sim_build_test_vt', '{}'::jsonb, 10)`);
      const sent = await c.query(
        `SELECT enqueued_at, vt FROM pgmq.q_sim_build_test_vt`,
      );
      assertEquals(sent.rows[0].enqueued_at, new Date("2030-01-01T00:00:00Z"));
      assertEquals(sent.rows[0].vt, new Date("2030-01-01T00:00:10Z"));

      const read = () =>
        c.query(`SELECT msg_id, vt FROM pgmq.read('sim_build_test_vt', 30, 1)`);
      await setNow("2030-01-01 00:00:09+00");
      assertEquals(
        (await read()).rowCount,
        0,
        "invisible before its delay elapses",
      );

      await setNow("2030-01-01 00:00:11+00");
      const got = await read();
      assertEquals(got.rowCount, 1, "visible once virtual time passes vt");
      assertEquals(got.rows[0].vt, new Date("2030-01-01T00:00:41Z"));
      assertEquals(
        (await read()).rowCount,
        0,
        "hidden again for the read's 30s",
      );
    }),
});

Deno.test({
  name: "after the sim build pgmq still runs on real time outside fsm_sim",
  ...integration,
  fn: () =>
    inRolledBackTxn(async (c) => {
      await buildSimDb(c);
      await c.query(`SELECT pgmq.create('sim_build_test_real')`);
      await c.query(`SELECT pgmq.send('sim_build_test_real', '{}'::jsonb)`);
      const r = await c.query(
        `SELECT enqueued_at = now() AS ok FROM pgmq.q_sim_build_test_real`,
      );
      assert(r.rows[0].ok, "enqueued_at should be the transaction's now()");
    }),
});

Deno.test({
  name: "the sim build unschedules the scheduler's pg_cron job",
  ...integration,
  fn: () =>
    inRolledBackTxn(async (c) => {
      await c.query(
        `SELECT cron.schedule('sim_build_test_job', '5 seconds',
                              'SELECT fsm_core.schedule_all_pending();')`,
      );
      const report = await buildSimDb(c);
      assert(report.cronJobs.includes("sim_build_test_job"));
      const left = await c.query(
        `SELECT count(*)::int AS n FROM cron.job
         WHERE command ILIKE '%fsm_core.schedule_all_pending%'`,
      );
      assertEquals(left.rows[0].n, 0);
    }),
});

Deno.test({
  name: "the sim build is idempotent",
  ...integration,
  fn: () =>
    inRolledBackTxn(async (c) => {
      await buildSimDb(c);
      assertEquals(await buildSimDb(c), {
        functions: [],
        defaults: [],
        grants: [],
        cronJobs: [],
      });
    }),
});
