import type { DBDeps } from "@fsm/db";
import { tryFSMDBLock, releaseFSMDBLock } from "@fsm/db";
import { startFSMWorker, type VerifiedModule } from "./fsmworker.ts";

export async function startFSMWorkerWithDBLock(
  deps: DBDeps,
  queueName: string,
  fsm_name: string,
  fsm_version: number | string,
  activeLocks: Record<string, boolean>,
  verifiedModule?: VerifiedModule,
  validatePlugin?: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  if (await tryFSMDBLock(deps, queueName)) {
    activeLocks[queueName] = true;
    startFSMWorker(deps, queueName, fsm_name, fsm_version, verifiedModule, validatePlugin, signal).catch((err) => {
      console.error(`FSM Worker for queue "${queueName}" stopped:`, err);
      delete activeLocks[queueName];
      releaseFSMDBLock(deps, queueName);
      console.log(`FSM Lock for queue "${queueName}" has been released.`);
    });
    return true;
  }
  return false;
}
