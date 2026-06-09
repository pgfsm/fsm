import type { DBDeps } from "@pgfsm/db";

export async function stopFSMWorker(deps: DBDeps, queueName: string): Promise<void> {
  await deps.db.query("SELECT pg_notify('fsm_worker_stop', $1)", [queueName]);
}
