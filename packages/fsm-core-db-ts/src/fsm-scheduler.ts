import { getLogger } from "@logtape/logtape";
import type { DBDeps } from "./custom-type.ts";
import { FSM_SCHEMA } from "./const.ts";

const logger = getLogger(["@pgfsm/db", "scheduler"]);

const ENQUEUE_FSM_DISPATCH_FN = `${FSM_SCHEMA}.enqueue_fsm_dispatch_v2`;
const RESUME_EVENT_FOR_FSM_WORKER_FN =
  `${FSM_SCHEMA}.resume_event_for_fsm_worker_v2`;

export type FsmDispatchType = "start" | "resume";

export type ResumeEventResult = {
  status: "queued" | "fsm_not_found";
  fsm_instance_id: string;
  fsm_name?: string;
  fsm_version?: string;
};

/**
 * Looks up fsm_name + fsm_version from fsm_instance, inserts a 'resume' entry
 * into fsm_dispatch_queue, and notifies the fsmscheduler — all in one PG call.
 * Replaces the getFsmDataResolveStateValue + enqueueDispatch two-call pattern.
 */
export async function resumeEventForFsmWorker(
  deps: DBDeps,
  instanceId: string,
): Promise<ResumeEventResult> {
  const res = await deps.db.query<{ result: ResumeEventResult }>(
    `SELECT ${RESUME_EVENT_FOR_FSM_WORKER_FN}($1::uuid) AS result`,
    [instanceId],
  );
  return res.rows[0].result;
}

export async function enqueueDispatch(
  deps: DBDeps,
  instanceId: string,
  fsmName: string,
  fsmVersion: string,
  dispatchType: FsmDispatchType = "start",
): Promise<void> {
  await deps.db.query(
    `SELECT ${ENQUEUE_FSM_DISPATCH_FN}($1, $2, $3, $4)`,
    [instanceId, fsmName, fsmVersion, dispatchType],
  );
  logger.debug("Enqueued {instanceId} ({fsmName}@{fsmVersion}, type={type})", {
    instanceId,
    fsmName,
    fsmVersion,
    type: dispatchType,
  });
}
