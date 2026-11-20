import { getLogger } from "@logtape/logtape";
import type { DBDeps } from "../custom.types.ts";
import { FSM_SCHEMA, FSM_SCHEMA_FN_VERSION } from "../const.ts";

const logger = getLogger(["@pgfsm/db", "fsm-sync-operation-scheduler"]);

const SCHEDULE_NEXT_PENDING_FN = `${FSM_SCHEMA}.schedule_next_pending`;
const SCHEDULER_JOB_STATUS_FN =
  `${FSM_SCHEMA}.scheduler_job_status_${FSM_SCHEMA_FN_VERSION}`;
const REGISTER_SCHEDULER_JOB_FN =
  `${FSM_SCHEMA}.register_scheduler_job_${FSM_SCHEMA_FN_VERSION}`;

/**
 * Thin wrapper around fsm_core.schedule_next_pending().
 * All scheduling logic (claim, filter+score fsmlets, assign, notify) runs
 * inside the PG function in a single transaction.
 * Returns true if an entry was scheduled, false if queue is empty or no
 * capable fsmlet is available.
 */
export async function scheduleNextPending(
  deps: DBDeps,
  staleThresholdSeconds = 30,
): Promise<boolean> {
  const res = await deps.db.query<{ schedule_next_pending: boolean }>(
    `SELECT ${SCHEDULE_NEXT_PENDING_FN}($1)`,
    [staleThresholdSeconds],
  );
  const scheduled = res.rows[0]?.schedule_next_pending ?? false;
  if (scheduled) {
    logger.info("schedule_next_pending: entry scheduled");
  }
  return scheduled;
}

/**
 * The fsm_schedule_all_pending pg_cron job, as fsm_core.scheduler_job_status_v2()
 * reports it (SPEC-016): `registered: false` when there's none.
 */
export type SchedulerJobStatus =
  | { jobname: string; registered: false }
  | {
    jobname: string;
    registered: true;
    jobid: number;
    schedule: string;
    command: string;
    active: boolean;
  };

/**
 * The fsm_schedule_all_pending pg_cron job's status
 * (fsm_core.scheduler_job_status_v2(); `GET /admin/scheduler`). SECURITY
 * DEFINER, granted to fsm_admin.
 */
export async function schedulerJobStatus(
  deps: DBDeps,
): Promise<SchedulerJobStatus> {
  const res = await deps.db.query<{ status: SchedulerJobStatus }>(
    `SELECT ${SCHEDULER_JOB_STATUS_FN}() AS status`,
  );
  return res.rows[0].status;
}

/**
 * Idempotently (re)registers the fsm_schedule_all_pending pg_cron job
 * (fsm_core.register_scheduler_job_v2(); `POST /admin/scheduler`) and returns
 * its status. The install and the 1.2.0 baseline migration already register it; this
 * re-registers it (e.g. after `cron.unschedule`) or changes its schedule
 * (pg_cron's syntax, e.g. '10 seconds'; default '5 seconds'). SECURITY
 * DEFINER, granted to fsm_admin, so the job always belongs to the schema
 * owner.
 */
export async function registerSchedulerJob(
  deps: DBDeps,
  inputSchedule?: string,
): Promise<SchedulerJobStatus> {
  const res = inputSchedule === undefined
    ? await deps.db.query<{ status: SchedulerJobStatus }>(
      `SELECT ${REGISTER_SCHEDULER_JOB_FN}() AS status`,
    )
    : await deps.db.query<{ status: SchedulerJobStatus }>(
      `SELECT ${REGISTER_SCHEDULER_JOB_FN}(input_schedule => $1) AS status`,
      [inputSchedule],
    );
  const status = res.rows[0].status;
  logger.info("Registered the {jobname} pg_cron job: {schedule}", {
    jobname: status.jobname,
    schedule: status.registered ? status.schedule : "(not registered)",
  });
  return status;
}
