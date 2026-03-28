import { EventEmitter } from "node:events";

import type { DBDeps } from "@fsm/db";
import { tryFSMDBLock, releaseFSMDBLock } from "@fsm/db";
import { startFSMWorker } from "./fsmworker.ts";

export async function startFSMWorkerWithDBLock(
  deps: DBDeps,
  queueName: string,
  fsm_name: string,
  fsm_version: number,
  activeLocks: Record<string, boolean>,
): Promise<EventEmitter | false> {
  if (!await tryFSMDBLock(deps, queueName)) {
    return false;
  }

  activeLocks[queueName] = true;
  const emitter = startFSMWorker(deps, queueName, fsm_name, fsm_version);

  emitter.on("error", (err) => {
    console.error(`FSM Worker for queue "${queueName}" stopped:`, err);
    delete activeLocks[queueName];
    releaseFSMDBLock(deps, queueName);
    console.log(`FSM Lock for queue "${queueName}" has been released.`);
  });

  return emitter;
}
