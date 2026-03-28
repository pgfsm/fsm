import type { DBDeps } from "@fsm/db";
import { tryFSMDBLock, releaseFSMDBLock } from "@fsm/db";
import { startFSMWorker } from "./fsmworker.ts";

export async function startFSMWorkerWithDBLock(
  deps: DBDeps,
  queueName: string,
  fsm_name: string,
  fsm_version: number,
  activeLocks: Record<string, boolean>,
): Promise<boolean> {
  if (await tryFSMDBLock(deps, queueName)) {
    activeLocks[queueName] = true;
    startFSMWorker(deps, queueName, fsm_name, fsm_version).catch((err) => {
      console.error(`FSM Worker for queue "${queueName}" stopped:`, err);
      delete activeLocks[queueName];
      releaseFSMDBLock(deps, queueName);
      console.log(`FSM Lock for queue "${queueName}" has been released.`);
    });
    return true;
  }
  return false;
}
