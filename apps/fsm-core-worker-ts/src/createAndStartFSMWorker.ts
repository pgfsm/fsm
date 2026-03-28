import type { DBDeps } from "@fsm/db";
import { createFSMInstanceFromName } from "@fsm/db";
import { startFSMWorkerWithDBLock } from "./fsmworker-lock.ts";

export async function createAndStartFSMWorker(
  deps: DBDeps,
  fsm_name: string,
  fsm_version: string | number | undefined,
  matchedModule: any,
  activeLocks: Record<string, boolean>,
  validatePlugin?: boolean,
) {
  const fsm_instance = await createFSMInstanceFromName(
    deps,
    fsm_name,
    fsm_version,
    true,
  );

  if (!fsm_instance || !fsm_instance.fsm_instance_id) {
    return null;
  }

  const started = await startFSMWorkerWithDBLock(
    deps,
    fsm_instance.fsm_instance_id,
    fsm_name,
    fsm_instance.fsm_version,
    activeLocks,
    matchedModule,
    validatePlugin,
  );

  if (!started) {
    console.error(`🚫 FSM Worker already running for queue "${fsm_instance.fsm_instance_id}"`);
  }

  return fsm_instance;
}
