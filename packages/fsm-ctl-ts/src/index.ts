// Library surface of @pgfsm/ctl. The package is mainly the `pgfsmctl` bin
// (src/cli/pgfsmctl.ts); this exports the fsmscheduler fallback loop for
// callers that embed it in-process (e.g. the fleet journey tests) instead of
// running `pgfsmctl scheduler run`.
export {
  runFsmScheduler,
  scheduleNextPending,
  SCHEDULER_NOTIFY_CHANNEL,
} from "./scheduler/fsmscheduler.ts";
export type { FsmSchedulerOptions } from "./scheduler/fsmscheduler.ts";
