// SPEC-013's end-to-end acceptance (#587), on the real stack from repository
// source: the pg_cron-equivalent scheduler, an fsmlet, the Activity Gateway
// (sidecar, poll loop) and the TypeScript worker SDK, against DATABASE_URL.
//
// spec013Input (see its machine.ts) runs three invokes after START. The echo
// actor returns the input it received, which the parent keeps in context, so
// the test sees exactly what each actor got:
//
// - an input function's result, computed by the sync worker from the
//   instance's context and the START event's payload;
// - a static input, the same for every instance;
// - an invoked child FSM's context: its declared context with the input
//   merged over it.
//
// Two instances with different contexts get different inputs. Runs with
// DATABASE_URL set; CI's "SPEC-011 end-to-end" job runs it too.

import { assertEquals } from "@std/assert";
// @ts-types="@types/pg"
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
import { ACTOR_REGISTRATIONS as PARENT_ACTORS } from "../../../../../test-apps/debug-only/async-worker/typescript/spec013Input/v01/actor-registry.generated.ts";
import parentFsmJson from "../../../../../test-apps/debug-only/sync-worker/typescript/spec013Input/v01/fsm.json" with {
  type: "json",
};
import childFsmJson from "../../../../../test-apps/debug-only/sync-worker/typescript/spec013Child/v01/fsm.json" with {
  type: "json",
};

const DATABASE_URL = Deno.env.get("DATABASE_URL");
const PARENT = "spec013Input";
const CHILD = "spec013Child";
const VERSION = "v01";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isSpec013 = (d: { fsmName: string; fsmVersion: string }) =>
  (d.fsmName === PARENT || d.fsmName === CHILD) && d.fsmVersion === VERSION;

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
    SYNC_OPERATION_REGISTRATIONS.filter(isSpec013),
    FSM_DEFINITIONS.filter(isSpec013),
    { signal: controller.signal },
  );

  const runId = crypto.randomUUID();
  const sidecarSocketPath = `/tmp/pgfsm-spec013-workers-${runId}.sock`;
  const gateway = startActivityGatewayServer({
    bindTarget: `unix:/tmp/pgfsm-spec013-gateway-${runId}.sock`,
    sidecarSocketPath,
    signal: controller.signal,
    asyncOpPollLoop: { deps, intervalMs: 200 },
    ensureQueueOnRegister: { deps },
  });
  await sleep(500);

  const worker = new ActorWorker(
    {
      workerId: `spec013-worker-${runId}`,
      language: "typescript",
      gatewaySocketPath: sidecarSocketPath,
    },
    [...PARENT_ACTORS],
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
  id: string;
  fsm_instance_state: unknown;
  fsm_instance_context: Record<string, unknown> | null;
}

async function instance(pool: Pool, id: string): Promise<InstanceRow> {
  const { rows } = await pool.query<InstanceRow>(
    `SELECT id, fsm_instance_state, fsm_instance_context
     FROM fsm_core.fsm_instance WHERE id = $1::uuid`,
    [id],
  );
  return rows[0];
}

async function waitForState(
  pool: Pool,
  id: string,
  state: string,
  timeoutMs = 20_000,
): Promise<InstanceRow> {
  const deadline = Date.now() + timeoutMs;
  let row: InstanceRow | undefined;
  while (Date.now() < deadline) {
    row = await instance(pool, id);
    if (
      JSON.stringify(row?.fsm_instance_state ?? null).includes(`"${state}"`)
    ) {
      return row;
    }
    await sleep(200);
  }
  throw new Error(
    `instance ${id} never reached ${state}; last state ${
      JSON.stringify(row?.fsm_instance_state)
    }`,
  );
}

async function childOf(pool: Pool, parentId: string): Promise<InstanceRow> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<InstanceRow>(
      `SELECT id, fsm_instance_state, fsm_instance_context
       FROM fsm_core.fsm_instance WHERE parent_fsm_instance_id = $1::uuid`,
      [parentId],
    );
    if (rows[0]) return rows[0];
    await sleep(200);
  }
  throw new Error(`instance ${parentId} never started its child FSM`);
}

async function startParent(
  deps: DBDeps,
  ssn: string,
): Promise<{ id: string; createdContext: unknown }> {
  const created = await createFsmInstanceFromName(deps, PARENT, VERSION, {
    ssn,
  }) as { fsm_instance_id: string; fsm_instance_context: unknown };
  return {
    id: created.fsm_instance_id,
    createdContext: created.fsm_instance_context,
  };
}

Deno.test({
  name:
    "SPEC-013 end-to-end: actors and child FSMs receive per-instance input (#587)",
  ignore: !DATABASE_URL,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const fleet = await startFleet();
    const { pool, deps } = fleet;
    try {
      const a = await startParent(deps, "123");
      const b = await startParent(deps, "999");

      // The declared context, merged with the context it's created with.
      assertEquals(a.createdContext, { ssn: "123", mapped: null, fixed: null });

      for (const [p, requestId] of [[a, "r1"], [b, "r2"]] as const) {
        await waitForState(pool, p.id, "Idle");
        await sendEventToFsmQueueWithEventLogs(
          deps,
          p.id,
          PARENT,
          VERSION,
          "START",
          "external",
          { requestId },
          0,
        );
      }

      const rowA = await waitForState(pool, a.id, "WithChild");
      const rowB = await waitForState(pool, b.id, "WithChild");

      // The input function's result, from each instance's context and event.
      assertEquals(rowA.fsm_instance_context?.mapped, {
        bureauName: "EquiGavin",
        ssn: "123",
        requestId: "r1",
      });
      assertEquals(rowB.fsm_instance_context?.mapped, {
        bureauName: "EquiGavin",
        ssn: "999",
        requestId: "r2",
      });
      // The static input, the same for both.
      assertEquals(rowA.fsm_instance_context?.fixed, {
        bureauName: "GavUnion",
      });
      assertEquals(rowB.fsm_instance_context?.fixed, {
        bureauName: "GavUnion",
      });

      // The child FSM: its declared context with the input merged over it.
      assertEquals((await childOf(pool, a.id)).fsm_instance_context, {
        tries: 0,
        ssn: "123",
      });
      assertEquals((await childOf(pool, b.id)).fsm_instance_context, {
        tries: 0,
        ssn: "999",
      });
    } finally {
      await stopFleet(fleet);
    }
  },
});
