import { getLogger } from "@logtape/logtape";
import { Pool } from "pg";
import type { PoolConfig } from "pg";

const logger = getLogger(["@pgfsm/worker", "bootstrap"]);

export type DbConfig = PoolConfig & { connectionString: string };
import {
  validateAndLoadFsmFromFolders,
  validateAndLoadPromiseFromFolders,
} from "@pgfsm/compiler";
import { createAndStartPromiseWorker } from "./create-and-start-promise-worker.ts";
import { pgListenerForWorkerStopEvent } from "./pg-listener-for-worker-stop-event.ts";

export type FsmFolderConfig = {
  folderPath: string;
  skipDirs?: string[];
};

export type FsmStartupConfig = {
  sharedPromise?: FsmFolderConfig;
  sharedFsm?: FsmFolderConfig;
  fsm?: FsmFolderConfig;
};

export type VerifiedFsmModule = {
  fsmName: string;
  fsmVersion: string;
  fsmType: string;
  fsmAbsFolderPath: string;
  fsmRelativeFolderPath: string;
  fsmParentDirName: string;
  fsmParentAbsFolderPath: string;
  fsmParentRelativeFolderPath: string;
  internalActors: any;
};

export type FsmWorkerEntry = { lock: boolean; controller: AbortController };

export type BootstrapOptions = {
  onWorkerStop?: (queueName: string) => void;
};

export type BootstrapResult = {
  pool: Pool;
  verifiedFsmModules: VerifiedFsmModule[];
};

export async function bootstrapFsmModules(
  dbConfig: DbConfig,
  fsmConfig?: FsmStartupConfig,
  options?: BootstrapOptions,
): Promise<BootstrapResult> {
  const pool = new Pool(dbConfig);

  let verifiedFsmModules: VerifiedFsmModule[] = [];

  if (fsmConfig) {
    const client = await pool.connect();
    client.release();
    const deps = { db: pool, useSupabase: false };

    const outputSharedPromise = fsmConfig.sharedPromise
      ? await validateAndLoadPromiseFromFolders(
          deps,
          fsmConfig.sharedPromise.folderPath,
          "sharedPromise",
          fsmConfig.sharedPromise.skipDirs ?? [],
          [],
        )
      : [];
    const verifiedSharedPromise = outputSharedPromise.filter(
      (m) => m.isFsmModuleVerified === true,
    );

    const outputSharedFsm = fsmConfig.sharedFsm
      ? await validateAndLoadFsmFromFolders(
          deps,
          fsmConfig.sharedFsm.folderPath,
          "sharedFsm",
          fsmConfig.sharedFsm.skipDirs ?? [],
          outputSharedPromise,
        )
      : [];
    const verifiedSharedFsm = outputSharedFsm.filter(
      (m) => m.isFsmModuleVerified === true,
    );

    const outputFsm = fsmConfig.fsm
      ? await validateAndLoadFsmFromFolders(
          deps,
          fsmConfig.fsm.folderPath,
          "fsm",
          fsmConfig.fsm.skipDirs ?? [],
          [...outputSharedPromise, ...outputSharedFsm],
        )
      : [];
    const verifiedFsm = outputFsm.filter((m) => m.isFsmModuleVerified === true);

    verifiedFsmModules = [
      ...verifiedSharedPromise,
      ...verifiedSharedFsm,
      ...verifiedFsm,
    ].map((m) => ({
      fsmName: m.fsmName,
      fsmVersion: m.fsmVersion,
      fsmType: m.fsmType,
      fsmAbsFolderPath: m.fsmAbsFolderPath,
      fsmRelativeFolderPath: m.fsmRelativeFolderPath,
      fsmParentDirName: m.fsmParentDirName,
      fsmParentAbsFolderPath: m.fsmParentAbsFolderPath,
      fsmParentRelativeFolderPath: m.fsmParentRelativeFolderPath,
      internalActors: m.internalActors,
    }));

    const allInternalActors = [
      ...verifiedSharedFsm,
      ...verifiedFsm,
    ].flatMap((fsm) =>
      (fsm.internalActors ?? []).map((actor: any) => ({
        src: actor.src,
        fsmName: actor.fsmName,
        fsmType: actor.fsmType,
        fsmVersion: actor.fsmVersion,
        parentFsmName: fsm.fsmName,
        parentFsmVersion: fsm.fsmVersion,
        fsmAbsFolderPath: fsm.fsmAbsFolderPath as string,
        controller: new AbortController(),
      }))
    );

    const promiseDeps = { db: pool, useSupabase: false };

    for (const actor of allInternalActors) {
      try {
        await createAndStartPromiseWorker(
          promiseDeps,
          `${actor.parentFsmName}_${actor.parentFsmVersion}_${actor.src}`,
          actor.src,
          actor.fsmType,
          actor.fsmVersion,
          { fsmAbsFolderPath: actor.fsmAbsFolderPath },
          actor.controller.signal,
        );
        logger.info("Promise worker started for actor: {src}", { src: actor.src });
      } catch (err) {
        logger.warning("Could not start promise worker for {src}: {error}", { src: actor.src, error: err });
      }
    }
  }

  if (options?.onWorkerStop) {
    await pgListenerForWorkerStopEvent(pool, options.onWorkerStop);
    logger.info("PG LISTEN active on channel: fsm_worker_stop");
  }

  return { pool, verifiedFsmModules };
}
