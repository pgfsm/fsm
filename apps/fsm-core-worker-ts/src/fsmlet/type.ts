import type { Pool } from "pg";
import type { PoolConfig } from "pg";

export type DbConfig = PoolConfig & { connectionString: string };

import type { FsmPluginValidationResult } from "@pgfsm/compiler";

export type FsmFolderConfig = {
  folderPath: string;
  skipDirs?: string[];
};

export type FsmStartupConfig = {
  sharedPromise?: FsmFolderConfig;
  fsm?: FsmFolderConfig;
};

export type BootstrapResult = {
  pool: Pool;
  verifiedFsmModules: FsmPluginValidationResult[];
};
