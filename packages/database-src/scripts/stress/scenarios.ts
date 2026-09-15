import type { Pool } from "pg";
import {
  type AsyncOperationWorkerIdentity,
  claimPendingAsyncOperationEventsForWorkers,
  claimScheduledForFsmlet,
  createFsmInstanceFromName,
  type DBDeps,
  scheduleNextPending,
} from "@pgfsm/db";
import { runForDuration, runWithConcurrency } from "./concurrency.ts";
import type { Recorder } from "./metrics.ts";
import { FIXTURE_FSM_NAME, FIXTURE_FSM_VERSION } from "./fixtures.ts";

export interface InstanceCreationBurstOptions {
  count: number;
  concurrency: number;
  createPgmqQueue: boolean;
}

/**
 * Bursts `count` fsm_instance creations at `concurrency` in flight, all
 * against the vitalsWorkflow/v01 fixture. `createPgmqQueue: false` isolates
 * the fsm_instance row-insert cost from per-instance pgmq queue creation —
 * see the queue-growth caveat in docs/guides/stress-testing.md.
 */
export async function instanceCreationBurst(
  deps: DBDeps,
  recorder: Recorder,
  options: InstanceCreationBurstOptions,
): Promise<void> {
  const tasks = Array.from(
    { length: options.count },
    () => () =>
      recorder.time(
        "createFsmInstanceFromName",
        () =>
          createFsmInstanceFromName(
            deps,
            FIXTURE_FSM_NAME,
            FIXTURE_FSM_VERSION,
            {},
            options.createPgmqQueue,
          ),
      ),
  );
  await runWithConcurrency(tasks, options.concurrency);
}

export interface MacrostepThroughputOptions {
  concurrency: number;
  durationMs: number;
}

// fsm_core.macrostep_v2 special-cases event_name = 'initialTransition_event':
// it resolves the initial transition directly, without needing candidate
// transitions for the (otherwise arbitrary) input state. That makes it safe
// to call repeatedly with the same fixed arguments from many concurrent
// callers, which is what this scenario wants — a raw-throughput benchmark
// of the function itself, decoupled from tracking real per-instance state.
const MACROSTEP_QUERY =
  `SELECT fsm_core.macrostep_v2($1::text, $2::text[], $3::text, $4::text) AS result`;
const MACROSTEP_ARGS = [
  "initialTransition_event",
  [],
  FIXTURE_FSM_NAME,
  FIXTURE_FSM_VERSION,
];

/**
 * Hammers fsm_core.macrostep_v2 directly (no TS wrapper exists for it yet)
 * at `concurrency` in flight for `durationMs`.
 */
export async function macrostepThroughput(
  pool: Pool,
  recorder: Recorder,
  options: MacrostepThroughputOptions,
): Promise<void> {
  await runForDuration(
    () =>
      recorder.time("macrostep_v2", async () => {
        await pool.query(MACROSTEP_QUERY, MACROSTEP_ARGS);
      }),
    options.concurrency,
    options.durationMs,
  );
}

export interface ClaimContentionOptions {
  fsmletPollerCount: number;
  schedulerPollerCount: number;
  asyncOpWorkerPollerCount: number;
  durationMs: number;
}

// asyncOperationType must be one of the two types
// compute_async_operation_queue_name_v2 recognizes — "internalAsyncOperation"
// or "sharedAsyncOperation" (see
// supabase/schemas/30_async_operation_worker_v2/20260806201803_ensure_async_operation_queue_for_worker.sql).
// This identity doesn't need to correspond to a real registered actor: the
// claim function computes a queue name and reads from it (or finds nothing),
// which is exactly the idle-poll overhead this scenario measures.
const STRESS_ASYNC_OP_WORKER: AsyncOperationWorkerIdentity = {
  parentFsmName: FIXTURE_FSM_NAME,
  parentFsmVersion: FIXTURE_FSM_VERSION,
  asyncOperationType: "internalAsyncOperation",
  asyncOperationName: "stress-harness-synthetic-worker",
  asyncOperationVersion: FIXTURE_FSM_VERSION,
  asyncOperationLanguage: "typescript",
};

/**
 * Simulates the real worker topology under load: many fsmlets claiming
 * scheduled dispatch entries (FOR UPDATE SKIP LOCKED), N fsm schedulers
 * assigning pending entries, and async-op worker pollers reading pgmq — all
 * concurrently, mostly against an empty queue (the common idle-poll case in
 * production). Measures poll/claim overhead and lock contention as poller
 * count scales, independent of whether there's real work queued.
 */
export async function claimContention(
  deps: DBDeps,
  recorder: Recorder,
  options: ClaimContentionOptions,
): Promise<void> {
  const loops: Array<Promise<void>> = [];

  for (let i = 0; i < options.fsmletPollerCount; i++) {
    // claim_scheduled_for_fsmlet takes input_fsmlet_id::uuid — must be a
    // real UUID, not a label.
    const fsmletId = crypto.randomUUID();
    loops.push(
      runForDuration(
        () =>
          recorder.time(
            "claimScheduledForFsmlet",
            () => claimScheduledForFsmlet(deps, fsmletId).then(() => {}),
          ),
        1,
        options.durationMs,
      ),
    );
  }

  for (let i = 0; i < options.schedulerPollerCount; i++) {
    loops.push(
      runForDuration(
        () =>
          recorder.time(
            "scheduleNextPending",
            () => scheduleNextPending(deps).then(() => {}),
          ),
        1,
        options.durationMs,
      ),
    );
  }

  for (let i = 0; i < options.asyncOpWorkerPollerCount; i++) {
    loops.push(
      runForDuration(
        () =>
          recorder.time(
            "claimPendingAsyncOperationEventsForWorkers",
            () =>
              claimPendingAsyncOperationEventsForWorkers(deps, [
                STRESS_ASYNC_OP_WORKER,
              ]).then(() => {}),
          ),
        1,
        options.durationMs,
      ),
    );
  }

  await Promise.all(loops);
}

export interface MixedWorkloadOptions {
  creation: InstanceCreationBurstOptions;
  macrostep: MacrostepThroughputOptions;
  claim: ClaimContentionOptions;
}

/**
 * Runs instance creation, macrostep throughput, and claim contention
 * concurrently — real deployments run sync macrostepping and async-op
 * dispatch at the same time, so isolated per-scenario numbers alone can
 * understate contention. The overall run length is bounded by
 * `macrostep.durationMs` / `claim.durationMs` (creation runs to completion
 * by `creation.count`, which the caller should size to roughly fit).
 */
export async function mixedWorkload(
  deps: DBDeps,
  pool: Pool,
  recorder: Recorder,
  options: MixedWorkloadOptions,
): Promise<void> {
  await Promise.all([
    instanceCreationBurst(deps, recorder, options.creation),
    macrostepThroughput(pool, recorder, options.macrostep),
    claimContention(deps, recorder, options.claim),
  ]);
}
