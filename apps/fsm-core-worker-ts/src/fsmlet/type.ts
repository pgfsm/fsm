import type { Pool } from "pg";
import type { PoolConfig } from "pg";
import type { Json } from "@pgfsm/db/database.types";

// Used in: fsmlet.ts, index.ts (direct import)
export type DbConfig = PoolConfig & { connectionString: string };

import type { FsmPluginValidationResult } from "@pgfsm/compiler";

// Used in: index.ts (direct import)
export type FsmFolderConfig = {
  folderPath: string;
  skipDirs?: string[];
};

// Used in: fsmlet.ts, cli/fsmlet.ts, index.ts (direct import),
// deprecated-inprocess-approach/deprecated_inprocess_worker.ts (via index.ts)
export type FsmStartupConfig = {
  sharedPromise?: FsmFolderConfig;
  fsm?: FsmFolderConfig;
};

// Used in: index.ts (direct import)
export type BootstrapResult = {
  pool: Pool;
  verifiedFsmModules: FsmPluginValidationResult[];
};

// Used in: fsmlet.ts
export type ActiveWorker = { controller: AbortController };

// Used in: fsmlet.ts, index.ts (direct import)
export type FsmletOptions = {
  signal?: AbortSignal;
  maxConcurrency?: number;
  asyncOperationVerificationMode?: string; // "none" | "checkReistry" | "checkRegistryAndWorking" default: "checkRegistryAndWorking"
  /** Called when a fsm_worker_stop pg_notify fires, after the fsmlet's own abort. */
  onWorkerStop?: (instanceId: string) => void;
  /**
   * Stable identity for this fsmlet node. If omitted a random UUID is generated
   * each startup. Pass a fixed value (e.g. from FSMLET_ID env var) so the
   * scheduler recognises restarts as the same node.
   */
  fsmletId?: string;
};

// Used in: fsmlet.ts, index.ts (direct import)
export type FsmletHandle = {
  pool: Pool | null;
  verifiedFsmWithAsyncOps: FsmPluginValidationResult[];
  fsmletId: string;
  /** Resolves when the fsmlet exits cleanly. Does NOT close the pool. */
  daemon: Promise<void>;
  getActiveWorkerIds: () => string[];
};

// Used in: fsmworker-helper.ts, index.ts (direct import)
export type FsmModuleDefinition = {
  actions: Record<string, (...args: unknown[]) => unknown> | null;
  guards: Record<string, (...args: unknown[]) => unknown> | null;
  delays: Record<string, (...args: unknown[]) => unknown> | null;
  actors: Record<string, (...args: unknown[]) => unknown> | null;
};

// Used in: fsmworker-helper.ts (macrostepV2 return type)
export type MacrostepV2Result = {
  remove_from_current_fsm_instance_queue_id: string;
  remove_current_queue_msg_id: number | null;
  remove_schedule_queue_msg_ids: Json[];
  remove_promise_queue_msg_ids: Json[];
  new_schedule_queue_data: Json[];
  new_promise_queue_data: Json[];
  total_schedule_queue_data: Json[];
  total_promise_queue_data: Json[];
  fsm_instance_data_save_fsm_status: Json;
  fsm_instance_data_save_fsm_state: Json;
  fsm_instance_data_save_fsm_context: Json;
  fsm_instance_data_save_fsm_error: Json;
  fsm_instance_data_save_fsm_output: Json;
  fsm_instance_data_save_fsm_xstate_state: Json;
  exit_actions: Json[];
  transition_actions: Json[];
  entry_actions: Json[];
};
