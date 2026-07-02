import type { DBDeps } from "@pgfsm/db";
import { stopEventForFsmWorker } from "@pgfsm/db";

export async function stopFSMWorker(
  deps: DBDeps,
  queueName: string,
): Promise<void> {
  await stopEventForFsmWorker(deps, queueName);
}
