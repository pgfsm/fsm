import type { DBDeps } from "@fsm/db";
import { createPgmqQueue } from "@fsm/db";
import { startFSMPromiseWorker } from "./fsmpromiseworker.ts";
import type { VerifiedModule } from "./fsmworker.ts";

export async function createAndStartPromiseWorker(
  deps: DBDeps,
  queueName: string,
  fsm_promise_name: string,
  fsm_promise_type: string,
  fsm_promise_version: string,
  verifiedModule?: VerifiedModule,
  signal?: AbortSignal,
  onStop?: () => void,
): Promise<boolean> {
  await createPgmqQueue(deps, queueName);

  startFSMPromiseWorker(deps, queueName, fsm_promise_name, fsm_promise_type, fsm_promise_version, verifiedModule, signal)
    .then(() => {
      console.log(`Promise worker for queue "${queueName}" stopped gracefully.`);
      onStop?.();
    })
    .catch((err) => {
      console.error(`Promise worker for queue "${queueName}" stopped:`, err);
      onStop?.();
    });

  return true;
}
