import type { DBDeps } from "@fsm/db";
import type { Json } from "@fsm/db/database.types";
import { createFsmInstanceFromName } from "@fsm/db";
import { startFSMWorkerWithDBLock } from "./fsmworker-lock.ts";
import type { VerifiedModule } from "./fsmworker.ts";

type FsmInstanceResult = { fsm_instance_id: string; fsm_version: string } & Record<string, Json>;

export async function createAndStartFSMWorker(
  deps: DBDeps,
  fsm_name: string,
  fsm_version: string,
  matchedModule: VerifiedModule,
  activeLocks: Record<string, boolean>,
  fsm_context: Json,
  validatePlugin?: boolean,
  signal?: AbortSignal,
) {
  const fsm_instance = await createFsmInstanceFromName(
    deps,
    fsm_name,
    fsm_version,
    fsm_context,
    true,
  ) as FsmInstanceResult | null;

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
    signal,
  );

  if (!started) {
    console.error(`🚫 FSM Worker already running for queue "${fsm_instance.fsm_instance_id}"`);
  }

  return fsm_instance;
}
