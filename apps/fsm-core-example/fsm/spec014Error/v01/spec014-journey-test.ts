// SPEC-014's end-to-end acceptance (#620), on the real stack from repository
// source: the pg_cron-equivalent scheduler and an fsmlet, against
// DATABASE_URL. Neither machine invokes an actor, so there's no gateway.
//
// spec014Error (see its machine.ts) has one scenario per event from Idle:
//
// - FLAKY's guard throws once, then passes. The worker retries FLAKY in place,
//   so NEXT, sent right after it, still arrives second: the instance ends in
//   Ordered.
// - BROKEN's guard always throws: after maxAttempts (the default, 3) the
//   instance is in status error, still in Idle, with the error saved.
// - START_CHILD invokes spec014Child, whose entry action always throws. The
//   fsmlet runs spec014Child with maxAttempts 1, so it errors on the first
//   attempt, and the parent's onError takes it to ChildFailed.
//
// Runs with DATABASE_URL set; CI's "SPEC-011 end-to-end" job runs it too.

import { assert, assertEquals } from "@std/assert";
// @ts-types="@types/pg"
import { Pool } from "pg";

import { runFsmScheduler } from "@pgfsm/ctl";
import { type FsmletHandle, startFsmlet } from "@pgfsm/sync-worker";
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
import parentFsmJson from "../../../../../test-apps/debug-only/sync-worker/typescript/spec014Error/v01/fsm.json" with {
  type: "json",
};
import childFsmJson from "../../../../../test-apps/debug-only/sync-worker/typescript/spec014Child/v01/fsm.json" with {
  type: "json",
};

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const PARENT = "spec014Error";
const CHILD = "spec014Child";
const VERSION = "v01";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isSpec014 = (d: { fsmName: string; fsmVersion: string }) =>
  (d.fsmName === PARENT || d.fsmName === CHILD) && d.fsmVersion === VERSION;

interface Fleet {
  pool: Pool;
  deps: DBDeps;
  controller: AbortController;
  fsmlet: FsmletHandle;
  done: Promise<unknown>[];
}

async function startFleet(): Promise<Fleet> {
  const connectionString = DATABASE_URL!;
  const pool = new Pool({ connectionString, max: 4 });
  const deps: DBDeps = { useSupabase: false, db: pool };
  const controller = new AbortController();

  // The child first: the parent invokes it.
  await loadFsmDefinitions(deps, [
    { fsmName: CHILD, fsmVersion: VERSION, fsmJson: childFsmJson },
    { fsmName: PARENT, fsmVersion: VERSION, fsmJson: parentFsmJson },
  ]);

  const scheduler = runFsmScheduler({ connectionString }, {
    signal: controller.signal,
  });
  await sleep(500);
  const fsmlet = await startFsmlet(
    { connectionString },
    SYNC_OPERATION_REGISTRATIONS.filter(isSpec014),
    FSM_DEFINITIONS.filter(isSpec014),
    {
      signal: controller.signal,
      // The parent keeps the default (3); the child errors on its first throw.
      syncOperationRetry: { fsms: { [CHILD]: { maxAttempts: 1 } } },
    },
  );
  await sleep(500);
  return { pool, deps, controller, fsmlet, done: [scheduler, fsmlet.daemon] };
}

async function stopFleet(fleet: Fleet): Promise<void> {
  fleet.controller.abort();
  await Promise.allSettled(fleet.done);
  await fleet.fsmlet.pool?.end();
  await fleet.pool.end();
}

interface InstanceRow {
  id: string;
  // null until the instance's first event is processed.
  state: string | null;
  status: string | null;
  error: Record<string, unknown> | null;
}

async function instance(pool: Pool, id: string): Promise<InstanceRow> {
  const { rows } = await pool.query<InstanceRow>(
    `SELECT id, fsm_instance_state::text AS state,
            fsm_instance_status #>> '{}' AS status,
            fsm_instance_error AS error
     FROM fsm_core.fsm_instance WHERE id = $1::uuid`,
    [id],
  );
  return rows[0];
}

async function waitFor(
  pool: Pool,
  id: string,
  what: string,
  done: (row: InstanceRow) => boolean,
  timeoutMs = 20_000,
): Promise<InstanceRow> {
  const deadline = Date.now() + timeoutMs;
  let row: InstanceRow | undefined;
  while (Date.now() < deadline) {
    row = await instance(pool, id);
    if (row && done(row)) return row;
    await sleep(200);
  }
  throw new Error(
    `instance ${id} never ${what}; last ${JSON.stringify(row)}`,
  );
}

const inState = (state: string) => (row: InstanceRow) =>
  (row.state ?? "").includes(`"${state}"`);

async function childOf(pool: Pool, parentId: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM fsm_core.fsm_instance WHERE parent_fsm_instance_id = $1::uuid`,
      [parentId],
    );
    if (rows[0]) return rows[0].id;
    await sleep(200);
  }
  throw new Error(`instance ${parentId} never started its child FSM`);
}

/** A new spec014Error instance, waiting in Idle. */
async function idleParent(fleet: Fleet): Promise<string> {
  const created = await createFsmInstanceFromName(
    fleet.deps,
    PARENT,
    VERSION,
    {},
  ) as { fsm_instance_id: string };
  const id = created.fsm_instance_id;
  await waitFor(fleet.pool, id, "reached Idle", inState("Idle"));
  return id;
}

const send = (fleet: Fleet, id: string, eventType: string) =>
  sendEventToFsmQueueWithEventLogs(
    fleet.deps,
    id,
    PARENT,
    VERSION,
    eventType,
    "external",
    {},
    0,
  );

Deno.test({
  name:
    "SPEC-014 end-to-end: a throwing sync operation is retried in place, then sets status error (#620)",
  ignore: !DATABASE_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const fleet = await startFleet();
    const { pool } = fleet;
    try {
      await t.step(
        "a guard that throws once is retried; the next event waits for it",
        async () => {
          const id = await idleParent(fleet);
          // Both queued before the worker gets to FLAKY's retry.
          await send(fleet, id, "FLAKY");
          await send(fleet, id, "NEXT");
          const row = await waitFor(
            pool,
            id,
            "reached Ordered",
            inState("Ordered"),
          );
          assertEquals(row.status, "active");
        },
      );

      await t.step(
        "a guard that always throws sets status error after 3 attempts",
        async () => {
          const id = await idleParent(fleet);
          await send(fleet, id, "BROKEN");
          const row = await waitFor(
            pool,
            id,
            "reached status error",
            (r) => r.status === "error",
          );
          // Nothing from the failed step: still in Idle.
          assert(inState("Idle")(row), `state ${row.state}`);
          assertEquals(row.error, {
            kind: "guard",
            name: "spec014AlwaysThrows",
            message: "spec014AlwaysThrows: always fails",
            attempts: 3,
            eventType: "BROKEN",
          });
        },
      );

      await t.step(
        "a child FSM's error (maxAttempts 1) reaches its parent's onError",
        async () => {
          const id = await idleParent(fleet);
          await send(fleet, id, "START_CHILD");
          const childId = await childOf(pool, id);
          const child = await waitFor(
            pool,
            childId,
            "reached status error",
            (r) => r.status === "error",
          );
          assertEquals(child.error?.kind, "action");
          assertEquals(child.error?.name, "spec014AlwaysThrowsAction");
          assertEquals(child.error?.attempts, 1);
          const parent = await waitFor(
            pool,
            id,
            "reached ChildFailed",
            inState("ChildFailed"),
          );
          assertEquals(parent.status, "active");
        },
      );
    } finally {
      await stopFleet(fleet);
    }
  },
});
