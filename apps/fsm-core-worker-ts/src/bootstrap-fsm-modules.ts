import { getLogger } from "@logtape/logtape";
import { Pool } from "pg";
import type { PoolConfig } from "pg";

const logger = getLogger(["@pgfsm/worker", "bootstrap"]);

export type DbConfig = PoolConfig & { connectionString: string };
import {
  validateAndLoadFsmFromFolders,
  validateAndLoadPromiseFromFolders,
} from "@pgfsm/compiler";
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

export type BootstrapResult = {
  pool: Pool;
  verifiedFsmModules: VerifiedFsmModule[];
};

export async function bootstrapFsmModules(
  dbConfig: DbConfig,
  fsmConfig?: FsmStartupConfig,
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
      externalActors: m.externalActors,
    }));

  }

  return { pool, verifiedFsmModules };
}
