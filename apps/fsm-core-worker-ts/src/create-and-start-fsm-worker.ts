import type { DBDeps } from "@pgfsm/db";
import type { Json } from "@pgfsm/db/database.types";
import { createFsmInstanceFromName } from "@pgfsm/db";
import { startFSMWorkerWithDBLock } from "./fsmworker-lock.ts";
import type { VerifiedModule } from "./fsmworker.ts";

type FsmInstanceResult = { fsm_instance_id: string; fsm_version: string } & Record<string, Json>;

export async function createAndStartFSMWorker(
  deps: DBDeps,
  fsm_name: string,
  fsm_version: string,
  matchedModule: VerifiedModule,
  fsm_context: Json,
  validatePlugin?: boolean,
  signal?: AbortSignal,
  onStop?: () => void,
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
    matchedModule,
    validatePlugin,
    signal,
    onStop,
  );

  if (!started) {
    console.error(`🚫 FSM Worker already running for queue "${fsm_instance.fsm_instance_id}"`);
  }

  return fsm_instance;
}
