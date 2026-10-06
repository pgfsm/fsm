import { getLogger } from "@logtape/logtape";
import type { DBDeps } from "../custom.types.ts";
import { FSM_SCHEMA } from "../const.ts";

const logger = getLogger(["@pgfsm/db", "fsm-sync-operation-scheduler"]);

const SCHEDULE_NEXT_PENDING_FN = `${FSM_SCHEMA}.schedule_next_pending`;
const SCHEDULE_ALL_PENDING_FN = `${FSM_SCHEMA}.schedule_all_pending`;
const CRON_JOB_NAME = "fsm_schedule_all_pending";
const DEFAULT_CRON_SCHEDULE = "5 seconds";

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
 * Idempotently (re)registers the fsm_schedule_all_pending pg_cron job, which
 * calls fsm_core.schedule_all_pending() on a periodic schedule — replaces
 * fsmscheduler's standing LISTEN/poll loop with an in-database timer (see
 * spec-003-pgcron-fsm-scheduler.md).
 *
 * migra's structural diff (used to generate the versioned pgxn migration
 * scripts under supabase/migrations/) only picks up DDL — cron.schedule()
 * is a data-level side effect (a row insert into cron.job), so it can't be
 * captured there. This is the deploy-time step that performs it instead: run
 * once via `pgfsmctl db cron register` (@pgfsm/ctl) after applying
 * migrations, or whenever the schedule needs to change.
 *
 * Unschedules any pre-existing job with the same name first (cron.schedule()
 * errors on a duplicate jobname, unique per jobname+username), so this is
 * safe to re-run.
 */
export async function registerScheduleAllPendingCronJob(
  deps: DBDeps,
  cronSchedule = DEFAULT_CRON_SCHEDULE,
): Promise<void> {
  await deps.db.query(
    `DO $do$
     BEGIN
       IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = '${CRON_JOB_NAME}') THEN
         PERFORM cron.unschedule('${CRON_JOB_NAME}');
       END IF;
     END;
     $do$;`,
  );
  await deps.db.query(
    `SELECT cron.schedule($1, $2, $3)`,
    [CRON_JOB_NAME, cronSchedule, `SELECT ${SCHEDULE_ALL_PENDING_FN}();`],
  );
  logger.info(
    "registerScheduleAllPendingCronJob: registered {jobName} ({schedule})",
    {
      jobName: CRON_JOB_NAME,
      schedule: cronSchedule,
    },
  );
}

/**
 * Removes the fsm_schedule_all_pending pg_cron job if it exists
 * (`pgfsmctl db cron unregister`). Returns whether a job was removed, so
 * callers can tell "removed" from "wasn't registered" -- both succeed.
 */
export async function unregisterScheduleAllPendingCronJob(
  deps: DBDeps,
): Promise<boolean> {
  const res = await deps.db.query<{ removed: boolean }>(
    `SELECT cron.unschedule(jobname) AS removed
       FROM cron.job WHERE jobname = $1`,
    [CRON_JOB_NAME],
  );
  const removed = res.rows.some((r: { removed: boolean }) => r.removed);
  logger.info("unregisterScheduleAllPendingCronJob: {jobName} {outcome}", {
    jobName: CRON_JOB_NAME,
    outcome: removed ? "removed" : "was not registered",
  });
  return removed;
}

/** A row of pg_cron's `cron.job` table, as far as pgfsm reports it. */
export interface ScheduleAllPendingCronJob {
  jobid: number;
  jobname: string;
  schedule: string;
  command: string;
  active: boolean;
}

/**
 * The registered fsm_schedule_all_pending pg_cron job, or null when none is
 * registered (`pgfsmctl db cron status`).
 */
export async function getScheduleAllPendingCronJob(
  deps: DBDeps,
): Promise<ScheduleAllPendingCronJob | null> {
  const res = await deps.db.query<ScheduleAllPendingCronJob>(
    `SELECT jobid::int AS jobid, jobname, schedule, command, active
       FROM cron.job WHERE jobname = $1`,
    [CRON_JOB_NAME],
  );
  return res.rows[0] ?? null;
}
