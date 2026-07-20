import { getLogger } from "@logtape/logtape";
import type { DBDeps } from "@pgfsm/db";

const logger = getLogger(["@pgfsm/worker", "promise"]);
import { createPgmqQueue } from "@pgfsm/db";
import { startFSMPromiseWorker } from "../asyncOperationWorkerlet/fsmpromiseworker.ts";
import type { ActorPluginValidationResult } from "@pgfsm/compiler";

export async function createAndStartPromiseWorker(
  deps: DBDeps,
  queueName: string,
  fsm_promise_name: string,
  fsm_promise_type: string,
  fsm_promise_version: string,
  verifiedModule?: ActorPluginValidationResult,
  signal?: AbortSignal,
  onStop?: () => void,
): Promise<boolean> {
  await createPgmqQueue(deps, queueName);

  startFSMPromiseWorker(
    deps,
    queueName,
    fsm_promise_name,
    fsm_promise_type,
    fsm_promise_version,
    verifiedModule,
    signal,
  )
    .then(() => {
      logger.info("Promise worker for queue {queueName} stopped gracefully", {
        queueName,
      });
      onStop?.();
    })
    .catch((err) => {
      logger.error("Promise worker for queue {queueName} stopped: {error}", {
        queueName,
        error: err,
      });
      onStop?.();
    });

  return true;
}
