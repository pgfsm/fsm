import type { DBDeps } from "@pgfsm/db";
import type { Json } from "@pgfsm/db/database.types";
import { createFsmInstanceFromName } from "@pgfsm/db";
import { startFSMWorkerWithDBLock } from "../fsmlet/fsmworker.ts";
import type { FsmPluginValidationResult } from "@pgfsm/compiler";

type FsmInstanceResult =
  & { fsm_instance_id: string; fsm_version: string }
  & Record<string, Json>;
type WorkerResult = { status: "success" | "fail"; message: string };

export async function createAndStartFSMWorker(
  deps: DBDeps,
  fsm_name: string,
  fsm_version: string,
  matchedModule: FsmPluginValidationResult,
  fsm_context: Json,
  validatePlugin?: boolean,
  signal?: AbortSignal,
  onStop?: () => void,
): Promise<
  { fsm_instance: FsmInstanceResult | null; workerResult: WorkerResult | null }
> {
  const fsm_instance = await createFsmInstanceFromName(
    deps,
    fsm_name,
    fsm_version,
    fsm_context,
    true,
  ) as FsmInstanceResult | null;

  if (!fsm_instance || !fsm_instance.fsm_instance_id) {
    return { fsm_instance: null, workerResult: null };
  }

  const workerResult = await startFSMWorkerWithDBLock(
    deps,
    fsm_instance.fsm_instance_id,
    fsm_name,
    fsm_instance.fsm_version,
    matchedModule,
    validatePlugin,
    signal,
    onStop,
  );

  return { fsm_instance, workerResult };
}
