import type { DBDeps } from "@pgfsm/db";
import { lockFsmInstance, unlockFsmInstance } from "@pgfsm/db";
import { startFSMWorker, type VerifiedModule } from "./fsmworker.ts";

export async function startFSMWorkerWithDBLock(
  deps: DBDeps,
  queueName: string,
  fsm_name: string,
  fsm_version: number | string,
  verifiedModule?: VerifiedModule,
  validatePlugin?: boolean,
  signal?: AbortSignal,
  onStop?: () => void,
): Promise<boolean> {
  if (await lockFsmInstance(deps, queueName)) {
    const cleanup = () => {
      unlockFsmInstance(deps, queueName);
      onStop?.();
    };
    startFSMWorker(deps, queueName, fsm_name, fsm_version, verifiedModule, validatePlugin, signal)
      .then(() => {
        console.log(`FSM Lock for queue "${queueName}" released after graceful stop.`);
        cleanup();
      })
      .catch((err) => {
        console.error(`FSM Worker for queue "${queueName}" stopped:`, err);
        console.log(`FSM Lock for queue "${queueName}" has been released.`);
        cleanup();
      });
    return true;
  }
  return false;
}
