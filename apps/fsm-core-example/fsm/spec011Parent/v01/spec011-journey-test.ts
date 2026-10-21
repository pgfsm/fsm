// SPEC-011's end-to-end acceptance (#536), on the real stack from repository
// source: the pg_cron-equivalent scheduler, an fsmlet, the Activity Gateway
// (sidecar, poll loop) and the TypeScript worker SDK, against DATABASE_URL.
// Three scenarios, each on a fresh spec011Parent instance (see its machine.ts):
//
// A  a parent's timer exits the state that invoked a child FSM while the
//    child's actor runs: the child is stopped, its actor's message is
//    cancelled, and the parent never gets a done event for it;
// B  an actor's result arrives after its state exited: it is dropped;
// C  the invoking state is re-entered while the first invoke runs, and the
//    first's result arrives while the re-entered state waits for the second:
//    it is dropped, and the second's drives the parent.
//
// Runs with DATABASE_URL set and spec011Parent/spec011Child loadable; CI's
// "SPEC-011 end-to-end" job runs it. Each scenario waits out the late
// result it checks, so the file takes about 30s.

import { assert, assertEquals } from "@std/assert";
import { Pool } from "pg";

import { runFsmScheduler } from "@pgfsm/ctl";
import { type FsmletHandle, startFsmlet } from "@pgfsm/sync-worker";
import { startActivityGatewayServer } from "@pgfsm/async-worker-gateway";
import { ActorWorker } from "@pgfsm/async-worker-sdk";
import {
  createFsmInstanceFromName,
  type DBDeps,
  loadFsmDefinitions,
  sendEventToFsmQueueWithEventLogs,
} from "@pgfsm/db";
import {
  FSM_DEFINITIONS,
  SYNC_OPERATION_REGISTRATIONS,
} from "../../../../../test-apps/debug-only/sync-worker/typescript/sync-operation-registry-aggregate.generated.ts";
import { ACTOR_REGISTRATIONS as PARENT_ACTORS } from "../../../../../test-apps/debug-only/async-worker/typescript/spec011Parent/v01/actor-registry.generated.ts";
import parentFsmJson from "../../../../../test-apps/debug-only/sync-worker/typescript/spec011Parent/v01/fsm.json" with {
  type: "json",
};
import childFsmJson from "../../../../../test-apps/debug-only/sync-worker/typescript/spec011Child/v01/fsm.json" with {
  type: "json",
};
import { ACTOR_REGISTRATIONS as CHILD_ACTORS } from "../../../../../test-apps/debug-only/async-worker/typescript/spec011Child/v01/actor-registry.generated.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const PARENT = "spec011Parent";
const VERSION = "v01";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isSpec011 = (d: { fsmName: string; fsmVersion: string }) =>
  (d.fsmName === PARENT || d.fsmName === "spec011Child") &&
  d.fsmVersion === VERSION;

interface Fleet {
  pool: Pool;
  deps: DBDeps;
  controller: AbortController;
  fsmlet: FsmletHandle;
  worker: ActorWorker;
  done: Promise<unknown>[];
}

async function startFleet(): Promise<Fleet> {
  const connectionString = DATABASE_URL!;
  const pool = new Pool({ connectionString, max: 4 });
  const deps: DBDeps = { useSupabase: false, db: pool };
  const controller = new AbortController();

  // The fsmlet only starts if the database holds exactly these definitions
  // (the fsm.json its FSM_DEFINITIONS digests were computed from). The child
  // first: the parent invokes it.
  await loadFsmDefinitions(deps, [
    { fsmName: "spec011Child", fsmVersion: VERSION, fsmJson: childFsmJson },
    { fsmName: PARENT, fsmVersion: VERSION, fsmJson: parentFsmJson },
  ]);

  const scheduler = runFsmScheduler({ connectionString }, {
    signal: controller.signal,
  });
  await sleep(500);
  const fsmlet = await startFsmlet(
    { connectionString },
    SYNC_OPERATION_REGISTRATIONS.filter(isSpec011),
    FSM_DEFINITIONS.filter(isSpec011),
    { signal: controller.signal },
  );

  const runId = crypto.randomUUID();
  const sidecarSocketPath = `/tmp/pgfsm-spec011-workers-${runId}.sock`;
  const gateway = startActivityGatewayServer({
    bindTarget: `unix:/tmp/pgfsm-spec011-gateway-${runId}.sock`,
    sidecarSocketPath,
    signal: controller.signal,
    // Short, so a result is archived soon after the worker returns it.
    asyncOpPollLoop: { deps, intervalMs: 200 },
    ensureQueueOnRegister: { deps },
  });
  await sleep(500);

  const worker = new ActorWorker(
    {
      workerId: `spec011-worker-${runId}`,
      language: "typescript",
      gatewaySocketPath: sidecarSocketPath,
    },
    [...PARENT_ACTORS, ...CHILD_ACTORS],
  );
  const workerDone = worker.run();
  await sleep(500);

  return {
    pool,
    deps,
    controller,
    fsmlet,
    worker,
    done: [scheduler, fsmlet.daemon, gateway, workerDone],
  };
}

async function stopFleet(fleet: Fleet): Promise<void> {
  fleet.worker.stop();
  fleet.controller.abort();
  await Promise.allSettled(fleet.done);
  await fleet.fsmlet.pool?.end();
  await fleet.pool.end();
}

interface InstanceRow {
  fsm_instance_state: unknown;
  fsm_instance_status: unknown;
  fsm_instance_context: Record<string, unknown> | null;
}

async function instance(pool: Pool, id: string): Promise<InstanceRow> {
  const { rows } = await pool.query<InstanceRow>(
    `SELECT fsm_instance_state, fsm_instance_status, fsm_instance_context
     FROM fsm_core.fsm_instance WHERE id = $1::uuid`,
    [id],
  );
  return rows[0];
}

/** Whether a saved state value names `state` (state names here are unique). */
function isIn(row: InstanceRow | undefined, state: string): boolean {
  return JSON.stringify(row?.fsm_instance_state ?? null).includes(
    `"${state}"`,
  );
}

async function waitForState(
  pool: Pool,
  id: string,
  state: string,
  timeoutMs = 15_000,
): Promise<InstanceRow> {
  const deadline = Date.now() + timeoutMs;
  let row: InstanceRow | undefined;
  while (Date.now() < deadline) {
    row = await instance(pool, id);
    if (isIn(row, state)) return row;
    await sleep(200);
  }
  throw new Error(
    `instance ${id} never reached ${state}; last state ${
      JSON.stringify(row?.fsm_instance_state)
    }`,
  );
}

async function newParent(deps: DBDeps): Promise<string> {
  const created = await createFsmInstanceFromName(deps, PARENT, VERSION, {
    result: null,
  }) as { fsm_instance_id: string };
  return created.fsm_instance_id;
}

async function send(deps: DBDeps, id: string, event: string): Promise<void> {
  await sendEventToFsmQueueWithEventLogs(
    deps,
    id,
    PARENT,
    VERSION,
    event,
    "external",
    {},
    0,
  );
}

/** The actor/child result events a parent's queue ever received. */
async function actorEventsSent(pool: Pool, id: string): Promise<string[]> {
  const { rows } = await pool.query<{ event_name: string }>(
    `SELECT event_name FROM fsm_core.fsm_instance_queue_event_logs
     WHERE fsm_instance_id = $1::uuid
       AND (event_name LIKE 'xstate.done.actor.%' OR event_name LIKE 'xstate.error.actor.%')
       AND event_source IS DISTINCT FROM 'internal'`,
    [id],
  );
  return rows.map((r: { event_name: string }) => r.event_name);
}

/** Async-operation log rows for one actor since `since`, in no order. */
async function actorLog(
  pool: Pool,
  actor: string,
  since: Date,
): Promise<{ msg_id: string; event_status: string }[]> {
  const { rows } = await pool.query<{ msg_id: string; event_status: string }>(
    `SELECT async_operation_queue_msg_id::text AS msg_id, event_status
     FROM fsm_core.fsm_async_operation_queue_event_logs
     WHERE async_operation_queue_name = fsm_core.compute_async_operation_queue_name_v2(
             $1, $2, 'internalAsyncOperation', $3, $2, 'typescript')
       AND COALESCE(execution_finished_at, execution_started_at) >= $4`,
    [PARENT, VERSION, actor, since],
  );
  return rows;
}

/**
 * Waits until the gateway has claimed a message of `actor` for a worker: one
 * is on its queue and invisible (its visibility timeout is running). Reads
 * the queue table only, so it doesn't count as a delivery.
 */
async function waitForClaim(pool: Pool, actor: string, timeoutMs = 10_000) {
  const { rows } = await pool.query<{ name: string }>(
    `SELECT fsm_core.compute_async_operation_queue_name_v2(
       $1, $2, 'internalAsyncOperation', $3, $2, 'typescript') AS name`,
    [PARENT, VERSION, actor],
  );
  // pgmq's table for a queue is q_<name>, lowercased.
  const table = `pgmq."q_${rows[0].name.toLowerCase()}"`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const claimed = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE vt > now()`,
    ).catch(() => ({ rows: [{ n: 0 }] }));
    if (claimed.rows[0].n > 0) return;
    await sleep(100);
  }
  throw new Error(`no message of ${actor} was claimed`);
}

Deno.test({
  name: "SPEC-011 end-to-end: stopping invokes when their state exits (#536)",
  ignore: !DATABASE_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const fleet = await startFleet();
    const { pool, deps } = fleet;
    try {
      await t.step(
        "A: exiting the state stops the invoked child FSM and its running actor",
        async () => {
          const parent = await newParent(deps);
          await waitForState(pool, parent, "Idle");
          await send(deps, parent, "START_CHILD");
          await waitForState(pool, parent, "WithChild");

          // The child is a real instance, and its actor starts.
          const { rows: children } = await pool.query<{ id: string }>(
            `SELECT id::text FROM fsm_core.fsm_instance WHERE parent_fsm_instance_id = $1::uuid`,
            [parent],
          );
          assertEquals(children.length, 1, "one child instance");
          const child = children[0].id;
          await waitForState(pool, child, "Working");

          // The parent's 2s timer exits WithChild while the child's actor
          // (10s) runs.
          await waitForState(pool, parent, "ChildAbandoned");
          const childRow = await instance(pool, child);
          assertEquals(childRow.fsm_instance_status, "stopped");

          // Its stop cancelled the actor's message.
          const { rows: stops } = await pool.query<{ data: unknown }>(
            `SELECT event_data AS data FROM fsm_core.fsm_instance_queue_event_logs
             WHERE fsm_instance_id = $1::uuid AND event_name = 'stop_child'`,
            [child],
          );
          assertEquals(stops.length, 1, "one stop_child row");
          const stopped = (stops[0].data as {
            stopped_invokes: { status: string; archive_result: boolean }[];
          }).stopped_invokes;
          assertEquals(stopped.map((s) => s.status), ["canceled"]);

          // Let the child's actor finish (10s from its start): its result
          // must be dropped, and the parent must stay where it is.
          await sleep(10_500);
          assert(isIn(await instance(pool, parent), "ChildAbandoned"));
          assertEquals(await actorEventsSent(pool, parent), []);
          assertEquals(
            (await instance(pool, child)).fsm_instance_status,
            "stopped",
          );
        },
      );

      await t.step(
        "B: an actor result that arrives after its state exited is not sent to the parent",
        async () => {
          const since = new Date();
          const parent = await newParent(deps);
          await waitForState(pool, parent, "Idle");
          await send(deps, parent, "START_SLOW");
          await waitForState(pool, parent, "Slow");
          // The 1s timer exits Slow while the actor (3s) runs.
          await waitForState(pool, parent, "TimedOut");

          await sleep(3_500);
          assert(isIn(await instance(pool, parent), "TimedOut"));
          assertEquals(await actorEventsSent(pool, parent), []);
          // The exit cancelled the message; the late result found it
          // archived and was discarded.
          // (Starting the invoke also logs async_operation_started.)
          const outcomes = (await actorLog(pool, "spec011SlowWork", since))
            .map((r) => r.event_status)
            .filter((status) => status !== "async_operation_started")
            .sort();
          assertEquals(outcomes, ["canceled", "discarded"]);
        },
      );

      await t.step(
        "C: re-entering the invoking state: the second invoke's result drives the parent",
        async () => {
          const since = new Date();
          const parent = await newParent(deps);
          await waitForState(pool, parent, "Idle");
          await send(deps, parent, "START_RETRY");
          await waitForState(pool, parent, "Retrying");

          // RETRY once the gateway has claimed the first invoke (1.5s) for
          // the worker (or it would be cancelled before it ran), about 0.5s
          // into it.
          await waitForClaim(pool, "spec011RetryWork");
          await sleep(300);
          await send(deps, parent, "RETRY");

          // The first's result (at ~1.5s) arrives while the re-entered state
          // waits; without SPEC-011 it would finish the state with invoke 1.
          const done = await waitForState(pool, parent, "RetryDone");
          assertEquals(done.fsm_instance_context?.result, { invoke: 2 });
          const statuses = (await actorLog(pool, "spec011RetryWork", since))
            .map((r) => r.event_status);
          assert(
            statuses.includes("discarded"),
            `the first invoke's late result is discarded: ${statuses}`,
          );
        },
      );
    } finally {
      await stopFleet(fleet);
    }
  },
});
