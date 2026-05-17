# TypeScript Function Rename Suggestions

> **All suggestions in this document have been applied.** `database.types.ts` requires regeneration (`npm run supabase:gen:types`) to reflect the PG argument renames (`p_*` → `input_*`).

Suggestions to align TypeScript function names and arguments with the PostgreSQL functions they wrap. PostgreSQL is the source of truth.

---

## Function Name Changes

TS function names omit the `_v1` / `_v2` version suffix — they are version-agnostic and delegate to whichever PG version is active via `FSM_SCHEMA_FN_VERSION`.

| Current TS Name | Suggested TS Name | PG Function | Reason | Status |
|---|---|---|---|---|
| `loadFsmStateFromJsonV2` | `loadFsmStateFromJson` | `load_fsm_state_from_json_v2` | Drop version suffix from TS name | Implemented |
| `loadFsmTransitionFromJsonV2` | `loadFsmTransitionFromJson` | `load_fsm_transition_from_json_v2` | Drop version suffix from TS name | Implemented |
| `loadFsmFromJsonV2` | `loadFsmFromJson` | `load_fsm_from_json_v2` | Drop version suffix from TS name | Implemented |
| `performMicrostep` | `microstep` | `microstep_v2` | Adds a verb not in the PG name | Implemented |
| `selectTransitions` | `selectAllTransitions` | `select_all_transitions_v2` | Drops `All` from the PG name | Implemented |
| `archive_event_from_fsm_type_worker` | `archiveEventFromFsmTypeWorker` | `archive_event_from_fsm_type_worker_v2` | snake_case in a camelCase codebase | Implemented |
| `archive_event_from_fsm_promise_type_worker` | `archiveEventFromFsmPromiseTypeWorker` | `archive_event_from_fsm_promise_type_worker_v2` | snake_case in a camelCase codebase | Implemented |
| `getFSMDataAndResolveStateValue` | `getFsmDataResolveStateValue` | `get_fsm_data_resolve_state_value_v2` | `And` not in PG name; `FSM` → `Fsm` for consistent camelCase | Implemented |
| `createFSMInstanceFromName` | `createFsmInstanceFromName` | `create_fsm_instance_from_name_v2` | `FSM` → `Fsm` for consistent camelCase | Implemented |
| `sendFSMEvent` | `sendEventToFsmQueueWithEventLogs` | `send_event_to_fsm_queue_with_event_logs_v2` | Highly abbreviated — loses queue/log context | Implemented |
| `tryFSMDBLock` | `lockFsmInstance` | `lock_fsm_instance` | `try`/`DB` not in PG name; PG verb is `lock` not `try` | Implemented |
| `releaseFSMDBLock` | `unlockFsmInstance` | `unlock_fsm_instance` | `release`/`DB` not in PG name; PG verb is `unlock` not `release` | Implemented |

> `resolveStateValue` already matches `resolve_state_value_v2` without the suffix — no change needed.

> PGMQ queue functions (`createPgmqQueue`, `readMessage`, `deleteMessage`, `archiveMessage`, `pgmqQueueExists`) are intentionally kept as-is — the underlying PG names (`create`, `read`, `delete`, `archive`, `list_queues`) are too generic to use directly in TypeScript.

---

## Argument Name Changes

### `fsm-helper.ts`

**`loadFsmStateFromJsonV2`** → PG: `load_fsm_state_from_json_v2`

| Current | Suggested | PG Param |
|---|---|---|
| `fsm_name` | `input_fsm_name` | `input_fsm_name` |
| `fsm_version` | `input_fsm_version` | `input_fsm_version` |

**`loadFsmFromJsonV2`** → PG: `load_fsm_from_json_v2`

| Current | Suggested | PG Param |
|---|---|---|
| `fsm_type` | `input_fsm_type` | `input_fsm_type` |
| `fsm_name` | `input_fsm_name` | `input_fsm_name` |
| `fsm_version` | `input_fsm_version` | `input_fsm_version` |

**`resolveStateValue`** → PG: `resolve_state_value_v2`

| Current | Suggested | PG Param |
|---|---|---|
| `fsm_name` | `input_fsm_name` | `input_fsm_name` |
| `fsm_version` | `input_fsm_version` | `input_fsm_version` |

**`performMicrostep`** → PG: `microstep_v2`

| Current | Suggested | PG Param |
|---|---|---|
| `fsm_name` | `fsm_name_param` | `fsm_name_param` |
| `fsm_version` | `fsm_version_param` | `fsm_version_param` |

**`selectTransitions`** → PG: `select_all_transitions_v2` *(Implemented)*

| Current | Suggested | PG Param |
|---|---|---|
| `source_state_value_set` | `input_state_value` | `input_state_value` |
| `fsm_name` | `fsm_name_param` | `fsm_name_param` |
| `fsm_version` | `fsm_version_param` | `fsm_version_param` |

---

### `fsm-instance.ts`

**`createFSMInstanceFromName`** → PG: `create_fsm_instance_from_name_v2`

| Current | Suggested | PG Param |
|---|---|---|
| `fsmName` | `input_fsm_name` | `input_fsm_name` |
| `fsmVersion` | `input_fsm_version` | `input_fsm_version` |
| `fsmContext` | `input_fsm_context` | `input_fsm_context` |
| `createQueue` | `create_pgmq_queue` | `create_pgmq_queue` |

**`sendFSMEvent`** → PG: `send_event_to_fsm_queue_with_event_logs_v2`

| Current | Suggested | PG Param |
|---|---|---|
| `fsm_instance_id` | `input_fsm_instance_id` | `input_fsm_instance_id` |
| `fsm_instance_id_fsm_type` | `input_fsm_instance_id_fsm_type` | `input_fsm_instance_id_fsm_type` |
| `fsm_instance_id_fsm_version` | `input_fsm_instance_id_fsm_version` | `input_fsm_instance_id_fsm_version` |
| `send_to_parent_queue_id` | `input_send_to_parent_queue_id` | `input_send_to_parent_queue_id` |
| `send_to_parent_queue_type` | `input_send_to_parent_queue_type` | `input_send_to_parent_queue_type` |
| `send_to_parent_queue_id_event_name` | `input_send_to_parent_queue_id_event_name` | `input_send_to_parent_queue_id_event_name` |
| `event_name` | `input_event_name` | `input_event_name` |
| `event_action_type` | `input_event_action_type` | `input_event_action_type` |
| `event_data` | `input_event_data` | `input_event_data` |
| `event_delay` | `input_event_delay` | `input_event_delay` |

**`getFSMDataAndResolveStateValue`** → PG: `get_fsm_data_resolve_state_value_v2`

| Current | Suggested | PG Param |
|---|---|---|
| `id` | `input_fsm_id` | `input_fsm_id` |

**`archive_event_from_fsm_type_worker`** → PG: `archive_event_from_fsm_type_worker_v2`

| Current | Suggested | PG Param |
|---|---|---|
| `remove_schedule_queue_msg_ids` | `to_be_removed_schedule_queue_msg_ids` | `to_be_removed_schedule_queue_msg_ids` |
| `remove_promise_queue_msg_ids` | `to_be_removed_promise_queue_msg_ids` | `to_be_removed_promise_queue_msg_ids` |
| `input_schedule_queue_data` | `to_be_added_schedule_queue_data` | `to_be_added_schedule_queue_data` |
| `input_promise_queue_data` | `to_be_added_promise_queue_data` | `to_be_added_promise_queue_data` |

---

### `fsm-instance-lock.ts`

**`tryFSMDBLock`** → PG: `lock_fsm_instance` *(Implemented)*

| Current | Suggested | PG Param |
|---|---|---|
| `fsmInstanceId` | `input_fsm_instance_id` | `input_fsm_instance_id` |

**`releaseFSMDBLock`** → PG: `unlock_fsm_instance` *(Implemented)*

| Current | Suggested | PG Param |
|---|---|---|
| `fsmInstanceId` | `input_fsm_instance_id` | `input_fsm_instance_id` |
