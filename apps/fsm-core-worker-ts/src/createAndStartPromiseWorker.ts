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
): Promise<boolean> {
  // 1. Create the PGMQ queue
  await createPgmqQueue(deps, queueName);

  // 2. Fire the promise worker loop in the background (do not await — the loop runs indefinitely)
  startFSMPromiseWorker(
    deps,
    queueName,
    fsm_promise_name,
    fsm_promise_type,
    fsm_promise_version,
    verifiedModule,
    signal,
  ).catch((err) => {
    console.error(`Promise worker for queue "${queueName}" stopped:`, err);
  });

  return true;
}
