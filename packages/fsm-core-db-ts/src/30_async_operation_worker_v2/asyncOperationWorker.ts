import { getLogger } from "@logtape/logtape";
import type { Json } from "../database.types.ts";
import type { DBDeps } from "../custom.types.ts";
import { FSM_SCHEMA, FSM_SCHEMA_FN_VERSION } from "../const.ts";
import { toJsonbParam } from "../pg-utils.ts";

const logger = getLogger(["@pgfsm/db", "async-operation-worker"]);

const CLAIM_PENDING_ASYNC_OPERATION_EVENTS_FOR_WORKERS_FN =
  `${FSM_SCHEMA}.claim_pending_async_operation_events_for_workers_${FSM_SCHEMA_FN_VERSION}`;
const ENSURE_ASYNC_OPERATION_QUEUE_FOR_WORKER_FN =
  `${FSM_SCHEMA}.ensure_async_operation_queue_for_worker_${FSM_SCHEMA_FN_VERSION}`;
const COMPUTE_ASYNC_OPERATION_QUEUE_NAME_FN =
  `${FSM_SCHEMA}.compute_async_operation_queue_name_${FSM_SCHEMA_FN_VERSION}`;

/**
 * A registered async-operation-actor identity, as sent to
 * `claimPendingAsyncOperationEventsForWorkers` — mirrors
 * `@pgfsm/async-worker`'s `SidecarGateway`-registered actor shape
 * minus `handler` (an in-process function reference, not serializable to
 * Postgres).
 */
export interface AsyncOperationWorkerIdentity {
  parentFsmName: string;
  parentFsmVersion: string;
  asyncOperationType: string;
  asyncOperationName: string;
  asyncOperationVersion: string;
  asyncOperationLanguage: string;
}

type ClaimPendingAsyncOperationEventsForWorkersRow = {
  claim_pending_async_operation_events_for_workers_v2: Json;
};

/**
 * Thin wrapper around `claim_pending_async_operation_events_for_workers_v2()` — takes
 * the caller's currently-registered worker identities (no `handler`) and
 * returns pending async-operation-queue work matching them: for each identity, reads
 * up to one message (if any) from that identity's PGMQ queue, skipping
 * identities with no queue yet. See that function's own comment (and
 * `packages/fsm-core-async-op-worker/docs/guides/CLI-USAGE.md`'s "PGMQ
 * message payload shape" section) for the row shape returned.
 */
export async function claimPendingAsyncOperationEventsForWorkers(
  deps: DBDeps,
  workers: AsyncOperationWorkerIdentity[],
): Promise<Json[]> {
  try {
    const text =
      `SELECT * FROM ${CLAIM_PENDING_ASYNC_OPERATION_EVENTS_FOR_WORKERS_FN}($1::jsonb);`;
    const values = [
      toJsonbParam(
        workers.map((w) => ({
          parent_fsm_name: w.parentFsmName,
          parent_fsm_version: w.parentFsmVersion,
          async_operation_type: w.asyncOperationType,
          async_operation_name: w.asyncOperationName,
          async_operation_version: w.asyncOperationVersion,
          async_operation_language: w.asyncOperationLanguage,
        })),
      ),
    ];
    const res = await deps.db.query<
      ClaimPendingAsyncOperationEventsForWorkersRow
    >(text, values);
    // pg's query<R>() overloads resolve `res.rows` such that a bare
    // `.map((row) => ...)` callback loses R's type and falls back to
    // implicit any (TS7006) — every other query in this package only reads
    // `res.rows[0]`, which doesn't hit this; an explicit parameter
    // annotation is the fix (verified: the object-literal generic form
    // reproduces this outside pg too, a named type doesn't avoid it).
    return res.rows.map((row: ClaimPendingAsyncOperationEventsForWorkersRow) =>
      row.claim_pending_async_operation_events_for_workers_v2
    );
  } catch (err) {
    logger.error(
      "Error in claimPendingAsyncOperationEventsForWorkers: {error}",
      {
        error: err,
      },
    );
    throw new Error(
      "Failed to claim pending async-operation events for workers",
      {
        cause: err,
      },
    );
  }
}

export interface EnsureAsyncOperationQueueForWorkerResult {
  queueName: string;
  alreadyExisted: boolean;
}

/**
 * Thin wrapper around `ensure_async_operation_queue_for_worker_v2()` -- ensures a
 * PGMQ queue exists for one async-operation-actor identity. asyncOperationType is
 * always shortened to its first character; when asyncOperationType is
 * exactly `"internalAsyncOperation"`, asyncOperationVersion is dropped
 * entirely and asyncOperationLanguage is also shortened to its first
 * character (both to help fit PGMQ's length limit -- see below):
 *
 * - `asyncOperationType === "internalAsyncOperation"`:
 *   `<parentFsmName>_<parentFsmVersion>_<asyncOperationType[0]>_<asyncOperationName>_<asyncOperationLanguage[0]>`
 * - otherwise (e.g. `"sharedAsyncOperation"`):
 *   `<parentFsmName>_<parentFsmVersion>_<asyncOperationType[0]>_<asyncOperationName>_<asyncOperationVersion>_<asyncOperationLanguage>`
 *
 * Idempotent: safe to call every time a worker registers this actor, not
 * just the first time (see fsm-core-async-op-worker's
 * `ensureQueueOnRegister` option).
 *
 * PGMQ enforces a hard 48-character queue name limit (`pgmq.validate_queue_name`)
 * -- this call throws if the computed name exceeds it. The `asyncOperationType ===
 * "internalAsyncOperation"` shortening above is enough for typical
 * identities (verified: `creditCheck_v01_i_checkReportsTable_t` = 37 chars
 * for a long real example), but long parentFsmName/asyncOperationName values
 * can still exceed it, and the non-`"internalAsyncOperation"` path (still
 * carrying full asyncOperationVersion + asyncOperationLanguage) remains more
 * exposed to this limit.
 */
export async function ensureAsyncOperationQueueForWorker(
  deps: DBDeps,
  identity: AsyncOperationWorkerIdentity,
): Promise<EnsureAsyncOperationQueueForWorkerResult> {
  try {
    const text =
      `SELECT * FROM ${ENSURE_ASYNC_OPERATION_QUEUE_FOR_WORKER_FN}($1::text, $2::text, $3::text, $4::text, $5::text, $6::text) AS result;`;
    const values = [
      identity.parentFsmName,
      identity.parentFsmVersion,
      identity.asyncOperationType,
      identity.asyncOperationName,
      identity.asyncOperationVersion,
      identity.asyncOperationLanguage,
    ];
    const res = await deps.db.query<
      { result: { queue_name: string; already_existed: boolean } }
    >(text, values);
    const result = res.rows?.[0]?.result;
    if (!result) {
      throw new Error(
        "ensure_async_operation_queue_for_worker_v2 returned no rows",
      );
    }
    return {
      queueName: result.queue_name,
      alreadyExisted: result.already_existed,
    };
  } catch (err) {
    logger.error("Error in ensureAsyncOperationQueueForWorker: {error}", {
      error: err,
    });
    throw new Error("Failed to ensure async-operation queue for worker", {
      cause: err,
    });
  }
}

/**
 * Thin wrapper around `compute_async_operation_queue_name_v2()` -- computes the PGMQ
 * queue name for one async-operation-actor identity, without creating or checking
 * the queue (see `ensureAsyncOperationQueueForWorker` for that). Callers that need
 * to derive an async-operation-actor's queue name -- e.g. `fsm-async-worker-ts`'s
 * `asyncOperationWorkerlet`, matching the same queue
 * `create_async_op_queue_and_send_event_from_fsm_instance_id_v2` (the fsmlet)
 * writes to -- should call this instead of re-deriving the naming rule
 * themselves, which is what let it drift out of sync before.
 */
export async function computeAsyncOperationQueueName(
  deps: DBDeps,
  identity: AsyncOperationWorkerIdentity,
): Promise<string> {
  try {
    const text =
      `SELECT ${COMPUTE_ASYNC_OPERATION_QUEUE_NAME_FN}($1::text, $2::text, $3::text, $4::text, $5::text, $6::text) AS queue_name;`;
    const values = [
      identity.parentFsmName,
      identity.parentFsmVersion,
      identity.asyncOperationType,
      identity.asyncOperationName,
      identity.asyncOperationVersion,
      identity.asyncOperationLanguage,
    ];
    const res = await deps.db.query<{ queue_name: string }>(text, values);
    const queueName = res.rows?.[0]?.queue_name;
    if (!queueName) {
      throw new Error("compute_async_operation_queue_name_v2 returned no rows");
    }
    return queueName;
  } catch (err) {
    logger.error("Error in computeAsyncOperationQueueName: {error}", {
      error: err,
    });
    throw new Error("Failed to compute async-operation queue name", {
      cause: err,
    });
  }
}
