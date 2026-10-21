// A parent and a child saving macrosteps at the same moment (SPEC-011 (b),
// #534). These need two real sessions, which a pgTAP test (one transaction)
// can't give: they run only with DATABASE_URL, as in CI's database job.
//
// The deadlock this guards against: the child's archive holds the child row
// and, telling its parent it finished, inserts a parent event-log row, whose
// foreign key takes FOR KEY SHARE on the parent row. The parent's archive
// holds the parent row and, exiting the invoking state, stops the child,
// which needs the child row. With the parent row locked FOR UPDATE the two
// wait on each other; with FOR NO KEY UPDATE the child's KEY SHARE goes
// through.

import { assert, assertEquals } from "@std/assert";
// @ts-types="@types/pg"
import { Pool, type PoolClient } from "pg";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const integration = { ignore: !DATABASE_URL, sanitizeResources: false };

const ARCHIVE = `SELECT fsm_core.archive_event_from_fsm_type_worker_v2(
  $1, $2::bigint, NULL, $3::jsonb, NULL, NULL, NULL, NULL,
  $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb) AS r`;

interface Family {
  parent: string;
  child: string;
  invokeId: string;
}

/** A parent with one running child FSM it invoked, each with its own queue. */
async function createFamily(pool: Pool): Promise<Family> {
  const parent = crypto.randomUUID();
  const child = crypto.randomUUID();
  const invokeId = `0.t534.${parent.slice(0, 8)}`;
  await pool.query(
    `INSERT INTO fsm_core.fsm_instance (id, fsm_name, fsm_version, fsm_instance_status, total_async_operation_queue_data)
     VALUES ($1::uuid, 't534Parent', 'v1', '"active"'::jsonb,
             jsonb_build_array(jsonb_build_object(
               'invoke_id', $3::text, 'src', 't534Child', 'async_operation_type', 'fsm',
               'queue_id', $2::text, 'queue_msg_id', 1)))`,
    [parent, child, invokeId],
  );
  await pool.query(
    `INSERT INTO fsm_core.fsm_instance (id, fsm_name, fsm_version, fsm_instance_status, parent_fsm_instance_id, parent_invoke_id)
     VALUES ($1::uuid, 't534Child', 'v1', '"active"'::jsonb, $2::uuid, $3)`,
    [child, parent, invokeId],
  );
  for (const queue of [parent, child]) {
    await pool.query(`SELECT pgmq.create($1)`, [queue]);
  }
  // The parent's queue: msg 1 (stays in the state), msg 2 (exits it).
  await pool.query(`SELECT pgmq.send($1, '{"stay": 1}'::jsonb)`, [parent]);
  await pool.query(`SELECT pgmq.send($1, '{"exit": 1}'::jsonb)`, [parent]);
  // The child's queue: msg 1 (finishes it).
  await pool.query(`SELECT pgmq.send($1, '{"finish": 1}'::jsonb)`, [child]);
  return { parent, child, invokeId };
}

async function dropFamily(pool: Pool, family: Family) {
  for (const id of [family.parent, family.child]) {
    await pool.query(`SELECT pgmq.drop_queue($1)`, [id]).catch(() => {});
    await pool.query(
      `DELETE FROM fsm_core.fsm_instance_queue_event_logs WHERE fsm_instance_id = $1::uuid`,
      [id],
    );
    await pool.query(
      `DELETE FROM fsm_core.fsm_instance_and_fsm_workerlet WHERE fsm_instance_id = $1::uuid`,
      [id],
    );
  }
  await pool.query(
    `DELETE FROM fsm_core.fsm_instance WHERE id = ANY($1::uuid[])`,
    [[family.child, family.parent]],
  );
}

async function withFamily(
  fn: (
    sessions: [PoolClient, PoolClient],
    family: Family,
    pool: Pool,
  ) => Promise<void>,
) {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  const family = await createFamily(pool);
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    // Fail instead of hanging if a session waits on the other.
    for (const session of [a, b]) {
      await session.query(`SET statement_timeout = '5s'`);
    }
    await fn([a, b], family, pool);
  } finally {
    for (const session of [a, b]) {
      await session.query("ROLLBACK").catch(() => {});
      session.release();
    }
    await dropFamily(pool, family);
    await pool.end();
  }
}

const exitInvoke = (family: Family) =>
  JSON.stringify([{ id: family.invokeId, src: "t534Child" }]);

async function parentQueueEvents(pool: Pool, parent: string) {
  const { rows } = await pool.query<{ t: string }>(
    `SELECT m.message->'eventData'->>'eventType' AS t FROM pgmq.read($1, 0, 10) m`,
    [parent],
  );
  return rows.map((row) => row.t);
}

Deno.test(
  "archive lock order: a child finishing while its parent holds its row, then the parent stopping it, doesn't deadlock (#534)",
  integration,
  async () => {
    await withFamily(async ([parentSession, childSession], family, pool) => {
      // The parent saves a macrostep and keeps its transaction open: it holds
      // its row as the archive locked it.
      await parentSession.query("BEGIN");
      await parentSession.query(ARCHIVE, [family.parent, 1, null, '"active"']);

      // The child finishes meanwhile and tells its parent. Its event-log row
      // for the parent must not wait for the parent's lock.
      await childSession.query("BEGIN");
      const child = await childSession.query(ARCHIVE, [
        family.child,
        1,
        null,
        '"done"',
      ]);
      assertEquals(
        child.rows[0].r.parent_notify_result.queue_data.eventData.eventType,
        `xstate.done.actor.${family.invokeId}`,
      );

      // The parent now exits the invoking state: stopping the child waits
      // for the child's transaction, which can commit.
      const exiting = parentSession.query(ARCHIVE, [
        family.parent,
        2,
        exitInvoke(family),
        '"active"',
      ]);
      await childSession.query("COMMIT");
      const parent = await exiting;
      await parentSession.query("COMMIT");

      // The child had already finished: there was nothing left to stop.
      assertEquals(
        parent.rows[0].r.confirmed_removed_async_operation_queue_data_failed
          .length,
        1,
      );
      assertEquals(await parentQueueEvents(pool, family.parent), [
        `xstate.done.actor.${family.invokeId}`,
      ]);
    });
  },
);

Deno.test(
  "archive lock order: a parent stopping its child first discards the child's in-flight macrostep (#534)",
  integration,
  async () => {
    await withFamily(async ([parentSession, childSession], family, pool) => {
      // The parent exits the invoking state and stops the child, holding
      // both rows.
      await parentSession.query("BEGIN");
      const parent = await parentSession.query(ARCHIVE, [
        family.parent,
        2,
        exitInvoke(family),
        '"active"',
      ]);
      assertEquals(
        parent.rows[0].r.confirmed_removed_async_operation_queue_data_success
          .length,
        1,
      );

      // The child's finishing macrostep waits for the child row, then finds
      // it stopped.
      await childSession.query("BEGIN");
      const finishing = childSession.query(ARCHIVE, [
        family.child,
        1,
        null,
        '"done"',
      ]);
      await parentSession.query("COMMIT");
      const child = await finishing;
      await childSession.query("COMMIT");

      assert(child.rows[0].r.discarded);
      assertEquals(child.rows[0].r.discarded_reason, "instance_not_active");
      // A stopped child reports nothing. (The parent's msg 1, never
      // processed here, is still on its queue.)
      assertEquals(
        (await parentQueueEvents(pool, family.parent)).filter((t) =>
          t?.startsWith("xstate.")
        ),
        [],
      );
      const { rows } = await pool.query<{ s: string }>(
        `SELECT fsm_instance_status #>> '{}' AS s FROM fsm_core.fsm_instance WHERE id = $1::uuid`,
        [family.child],
      );
      assertEquals(rows[0].s, "stopped");
    });
  },
);
