import { getLogger } from "@logtape/logtape";
import type { DBDeps } from "./custom-type.ts";
import { FSM_SCHEMA, FSM_SCHEMA_FN_VERSION } from "./const.ts";
import type { Json } from "./database.types.ts";

const logger = getLogger(["@pgfsm/db", "async-operation"]);

const ASYNC_OP_DISPATCH_TABLE =
  `${FSM_SCHEMA}.async_operation_instance_and_async_operation_workerlet`;
const ASYNC_OP_SCHEDULE_NEXT_PENDING_FN =
  `${FSM_SCHEMA}.async_operation_schedule_next_pending`;
const CHECK_REGISTRY_FOR_ASYNC_ACTORS_FN =
  `${FSM_SCHEMA}.check_registry_for_async_actors`;
const CHECK_REGISTRY_AND_WORKING_FOR_ASYNC_ACTORS_FN =
  `${FSM_SCHEMA}.check_registry_and_working_for_async_actors_for_fsm_instance_and_worklet`;

export type AsyncActor = {
  src: string;
  fsmVersion: string;
};

export type CheckRegistryForAsyncActorsResult = {
  all_registered: boolean;
  missing_actors: AsyncActor[];
  fsm_name: string;
  fsm_version: string;
};

export type CheckRegistryAndWorkingForAsyncActorsResult = {
  all_working: boolean;
  non_working_actors: AsyncActor[];
  fsm_name: string;
  fsm_version: string;
};

export type AsyncOperationDispatchInput = {
  asyncOperationInstanceId: string;
  asyncOperationName: string;
  asyncOperationVersion: string;
  asyncOperationType: string;
  parentFsmName: string;
  parentFsmVersion: string;
  asyncOperationLanguage: string;
};

/**
 * Inserts a pending dispatch entry into async_operation_instance_and_async_operation_workerlet
 * and wakes the async-operation scheduler via pg_notify — in a single atomic CTE query.
 */
export async function enqueueAsyncOperationDispatch(
  deps: DBDeps,
  input: AsyncOperationDispatchInput,
): Promise<void> {
  await deps.db.query(
    `WITH ins AS (
       INSERT INTO ${ASYNC_OP_DISPATCH_TABLE}
         (async_operation_instance_id, async_operation_name, async_operation_version,
          async_operation_type, parent_fsm_name, parent_fsm_version, async_operation_language)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
       RETURNING async_operation_instance_id
     )
     SELECT pg_notify('async_operation_scheduler_work', async_operation_instance_id::text)
     FROM ins`,
    [
      input.asyncOperationInstanceId,
      input.asyncOperationName,
      input.asyncOperationVersion,
      input.asyncOperationType,
      input.parentFsmName,
      input.parentFsmVersion,
      input.asyncOperationLanguage,
    ],
  );
  logger.debug(
    "Enqueued async operation {instanceId} ({name}@{version}, type={type}, lang={lang})",
    {
      instanceId: input.asyncOperationInstanceId,
      name: input.asyncOperationName,
      version: input.asyncOperationVersion,
      type: input.asyncOperationType,
      lang: input.asyncOperationLanguage,
    },
  );
}

/**
 * Atomically claims the oldest pending async-operation dispatch entry, assigns it
 * to the best available workerlet, and fires pg_notify to wake that workerlet.
 * Returns true if an entry was scheduled, false if the queue is empty or no
 * workerlet has capacity. Safe to call from multiple scheduler replicas concurrently.
 */
export async function asyncOperationScheduleNextPending(
  deps: DBDeps,
  staleThresholdSeconds = 30,
): Promise<boolean> {
  const res = await deps.db.query<{ result: boolean }>(
    `SELECT ${ASYNC_OP_SCHEDULE_NEXT_PENDING_FN}($1::int) AS result`,
    [staleThresholdSeconds],
  );
  return res.rows[0].result;
}

/**
 * Checks async_operation_instance_and_async_operation_workerlet to verify
 * every actor in asyncActors has an active (pending/scheduled) dispatch entry
 * for the given FSM. Returns which actors are not working, if any.
 */
export async function checkRegistryAndWorkingForAsyncActors(
  deps: DBDeps,
  asyncActors: AsyncActor[],
  fsmName: string,
  fsmVersion: string,
): Promise<CheckRegistryAndWorkingForAsyncActorsResult> {
  const res = await deps.db.query<
    { result: CheckRegistryAndWorkingForAsyncActorsResult }
  >(
    `SELECT ${CHECK_REGISTRY_AND_WORKING_FOR_ASYNC_ACTORS_FN}($1::jsonb, $2, $3) AS result`,
    [JSON.stringify(asyncActors), fsmName, fsmVersion],
  );
  return res.rows[0].result;
}

/**
 * Checks async_operation_meta to verify every actor in asyncActors is
 * registered for the given FSM. Returns which actors are missing, if any.
 */
export async function checkRegistryForAsyncActors(
  deps: DBDeps,
  asyncActors: AsyncActor[],
  fsmName: string,
  fsmVersion: string,
): Promise<CheckRegistryForAsyncActorsResult> {
  const res = await deps.db.query<
    { result: CheckRegistryForAsyncActorsResult }
  >(
    `SELECT ${CHECK_REGISTRY_FOR_ASYNC_ACTORS_FN}($1::jsonb, $2, $3) AS result`,
    [JSON.stringify(asyncActors), fsmName, fsmVersion],
  );
  return res.rows[0].result;
}

export async function loadAsyncOperation(
  deps: DBDeps,
  input_async_operation_name: string,
  input_async_operation_version: string,
  input_async_operation_type: string,
  input_async_operation_language: string,
  input_parent_fsm_name: string,
  input_parent_fsm_version: string,
  input_updated_by_pid: string,
): Promise<Json> {
  try {
    const LOAD_ASYNC_OP_META_FN =
      `${FSM_SCHEMA}.load_async_operation_meta_${FSM_SCHEMA_FN_VERSION}`;
    const text = `
      SELECT ${LOAD_ASYNC_OP_META_FN}(
        $1::text,
        $2::text,
        $3::text,
        $4::text,
        $5::text,
        $6::text,
        $7::text
      ) AS result;
    `;
    const values = [
      input_async_operation_name,
      input_async_operation_version,
      input_async_operation_type,
      input_async_operation_language,
      input_parent_fsm_name,
      input_parent_fsm_version,
      input_updated_by_pid,
    ];
    const res = await deps.db.query<{ result: Json }>(text, values);
    return res.rows?.[0]?.result ?? null;
  } catch (err) {
    logger.error("Error in loadAsyncOperation: {error}", { error: err });
    throw new Error("Failed to load async operation", { cause: err });
  }
}
