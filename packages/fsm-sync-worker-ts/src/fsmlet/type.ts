import type { Pool } from "pg";
import type { PoolConfig } from "pg";
import type { Database, Json } from "@pgfsm/db/database.types";
import type { FsmModule } from "@pgfsm/db";

/**
 * The PG-generated Args shape for `fsm_core.archive_event_from_fsm_type_worker_v2`
 * — the function `MacrostepV2Result` is ultimately built to feed (see
 * `fsmworker.ts`'s call to `archiveEventFromFsmTypeWorker`). Mirrors the
 * file-private `ArchiveWorkerArgs` alias in
 * `fsm-core-db-ts/src/35_fsm_sync_operation_worker_v1/fsmctl.ts`.
 */
type ArchiveWorkerArgs =
  Database["fsm_core"]["Functions"]["archive_event_from_fsm_type_worker_v2"][
    "Args"
  ];

// Used in: fsmlet.ts, index.ts (direct import)
export type DbConfig = PoolConfig & { connectionString: string };

// Used in: index.ts (direct import)
export type FsmFolderConfig = {
  folderPath: string;
  skipDirs?: string[];
};

/**
 * Single fsm.json file config — the fsmlet equivalent of fsm-compiler-ts's
 * `--folder <fsm.json>` single-file mode. There's no
 * `<fsmName>/<fsmVersion>/fsm.json` directory structure to infer identity
 * from, so `fsmName`/`fsmVersion` are caller-supplied.
 * Used in: fsmlet.ts, cli/fsmlet.ts, index.ts (direct import)
 */
export type FsmJsonFileConfig = {
  fsmJsonPath: string;
  fsmName: string;
  fsmVersion: string;
};

// Used in: fsmlet.ts, cli/fsmlet.ts, index.ts (direct import)
export type FsmStartupConfig = {
  sharedAsyncOperation?: FsmFolderConfig;
  fsm?: FsmFolderConfig | FsmJsonFileConfig;
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
  /**
   * Every `<fsmName>/<fsmVersion>` this fsmlet registered itself for —
   * derived directly from the statically-imported `SYNC_OPERATION_REGISTRATIONS`
   * aggregate registry, not from any validation/verification pass (fsmlet.ts
   * no longer does either — see fsm-sync-worker-ts #340).
   */
  registeredFsmModules: FsmModule[];
  fsmletId: string;
  /** Resolves when the fsmlet exits cleanly. Does NOT close the pool. */
  daemon: Promise<void>;
  getActiveWorkerIds: () => string[];
};

/**
 * One entry of the compiler-generated aggregate sync-operation registry
 * (`sync-worker/typescript/aggregate-generated-sync-operation-registry.ts` —
 * see fsm-compiler-ts #338), mirroring the `SyncOperationRegistration` type
 * that generated file itself declares. Not imported from `@pgfsm/compiler`
 * directly — that generated file is per-project output living under the
 * consumer's own `sync-worker/typescript/`, not a package this library
 * statically depends on, so it's loaded via dynamic `import()` at runtime
 * (see `sync-operation-registrations.ts`) and typed against this local
 * mirror instead.
 * Used in: sync-operation-registrations.ts, fsmworker.ts, fsmworker-helper.ts,
 * index.ts (direct import)
 */
export type SyncOperationRegistration = {
  fsmName: string;
  fsmVersion: string;
  syncOperationType: "action" | "guard" | "delay";
  syncOperationName: string;
  syncOperationLanguage: string;
  handler: (...args: unknown[]) => unknown;
};

/**
 * Used in: fsmworker-helper.ts (macrostepV2 return type). Field names/types
 * for the 12 fields `fsmworker.ts` actually forwards into
 * `archiveEventFromFsmTypeWorker` are tied to `ArchiveWorkerArgs` (so a rename
 * on the PG side follows automatically here) and renamed to match the PG
 * parameter names exactly — they used to diverge (e.g. `remove_*` /
 * `new_*` / bare `total_*` here vs. the PG function's `to_be_removed_*` /
 * `to_be_added_*` / `input_total_*`).
 *
 * `fsm_instance_data_save_fsm_error`, `fsm_instance_data_save_fsm_output`,
 * `exit_actions`, `transition_actions`, and `entry_actions` are computed by
 * `macrostepV2` but not part of `ArchiveWorkerArgs` — `fsmworker.ts` doesn't
 * forward them to any archive call today. Kept hand-written (schema has no
 * equivalent to derive from) rather than dropped, since nothing here confirms
 * they're dead vs. awaiting a future archive-fn version.
 */
export type MacrostepV2Result = {
  remove_from_current_fsm_instance_queue_id:
    ArchiveWorkerArgs["remove_from_current_fsm_instance_queue_id"];
  remove_current_queue_msg_id:
    | ArchiveWorkerArgs["remove_current_queue_msg_id"]
    | null;
  to_be_removed_schedule_queue_msg_ids:
    ArchiveWorkerArgs["to_be_removed_schedule_queue_msg_ids"];
  to_be_removed_async_operation_queue_msg_ids:
    ArchiveWorkerArgs["to_be_removed_async_operation_queue_msg_ids"];
  to_be_added_schedule_queue_data:
    ArchiveWorkerArgs["to_be_added_schedule_queue_data"];
  to_be_added_async_operation_queue_data:
    ArchiveWorkerArgs["to_be_added_async_operation_queue_data"];
  input_total_schedule_queue_data:
    ArchiveWorkerArgs["input_total_schedule_queue_data"];
  input_total_async_operation_queue_data:
    ArchiveWorkerArgs["input_total_async_operation_queue_data"];
  fsm_instance_data_save_fsm_status:
    ArchiveWorkerArgs["fsm_instance_data_save_fsm_status"];
  fsm_instance_data_save_fsm_state:
    ArchiveWorkerArgs["fsm_instance_data_save_fsm_state"];
  fsm_instance_data_save_fsm_context:
    ArchiveWorkerArgs["fsm_instance_data_save_fsm_context"];
  fsm_instance_data_save_fsm_xstate_state:
    ArchiveWorkerArgs["fsm_instance_data_save_fsm_xstate_state"];
  fsm_instance_data_save_fsm_error: Json;
  fsm_instance_data_save_fsm_output: Json;
  exit_actions: Json[];
  transition_actions: Json[];
  entry_actions: Json[];
};
