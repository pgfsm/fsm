# PostgreSQL → TypeScript Function Mapping

PostgreSQL (`packages/database-src/supabase/schemas/`) is the source of truth. TypeScript wrappers live in `apps/fsm-core-db-ts/src/`.

---

## Table 1: Direct 1:1 Mappings (PostgreSQL Function → TypeScript Wrapper)

| PostgreSQL Function | PG Input Arguments | Child PG Functions Called | TypeScript Function | TS File |
|---|---|---|---|---|
| `fsm_core.load_fsm_state_from_json_v2` | `json_input jsonb`, `root_node_text text`, `input_fsm_name text`, `input_fsm_version text` | `load_fsm_state_from_json_v2` (recursive), `sanitize_text_to_ltree` | `loadFsmStateFromJsonV2(deps, json_input, root_node_text, fsm_name, fsm_version)` | `fsm-helper.ts` |
| `fsm_core.load_fsm_transition_from_json_v2` | `json_input jsonb`, `root_node_text text`, `fsm_name text`, `fsm_version text` | `load_fsm_state_from_json_v2`, `load_fsm_transition_from_json_v2` (recursive), `sanitize_text_array_to_ltree_array`, `sanitize_text_to_ltree`, `sql_lca_from_array` | `loadFsmTransitionFromJsonV2(deps, json_input, root_node_text, fsm_name, fsm_version)` | `fsm-helper.ts` |
| `fsm_core.load_fsm_from_json_v2` | `json_input jsonb`, `root_node_text text`, `input_fsm_type text`, `input_fsm_name text`, `input_fsm_version text` | `load_fsm_state_from_json_v2`, `load_fsm_transition_from_json_v2` | `loadFsmFromJsonV2(deps, json_input, root_node_text, fsm_type, fsm_name, fsm_version)` | `fsm-helper.ts` |
| `fsm_core.resolve_state_value_v2` | `input_json jsonb`, `input_fsm_name text`, `input_fsm_version text` | `jsonb_all_paths`, `fsm_get_all_state_nodes_v2`, `build_nested_json_recursive` | `resolveStateValue(deps, input_json, fsm_name, fsm_version)` | `fsm-helper.ts` |
| `fsm_core.microstep_v2` | `transition_record fsm_core.fsm_transitions`, `event_name text`, `state_value_node_set text[]`, `fsm_name_param text`, `fsm_version_param text` | `build_nested_json_recursive`, `compute_exit_actions_v2`, `compute_entry_actions_v2` | `performMicrostep(deps, transition_record, event_name, state_value_node_set, fsm_name, fsm_version)` | `fsm-helper.ts` |
| `fsm_core.select_all_transitions_v2` | `event_name text`, `p_state_value text[]`, `fsm_name_param text`, `fsm_version_param text` | — | `selectTransitions(deps, event_name, source_state_value_set, fsm_name, fsm_version)` | `fsm-helper.ts` |
| `fsm_core.create_fsm_instance_from_name_v2` | `input_fsm_name text`, `input_fsm_version text`, `input_fsm_context jsonb`, `create_pgmq_queue boolean DEFAULT false` | `send_event_to_fsm_queue_with_event_logs_v2` | `createFSMInstanceFromName(deps, fsmName, fsmVersion, fsmContext, createQueue)` | `fsm-instance.ts` |
| `fsm_core.send_event_to_fsm_queue_with_event_logs_v2` | `input_fsm_instance_id uuid`, `input_fsm_instance_id_fsm_type text`, `input_fsm_instance_id_fsm_version text`, `input_send_to_parent_queue_id uuid`, `input_send_to_parent_queue_type text`, `input_send_to_parent_queue_id_event_name text`, `input_event_name text`, `input_event_action_type text`, `input_event_data jsonb`, `input_event_delay integer DEFAULT 0`, `input_event_status text DEFAULT 'ACTIVE'`, `input_event_output jsonb DEFAULT '{}'`, `input_error_message text DEFAULT NULL`, `input_execution_started_at timestamptz DEFAULT now()`, `input_execution_duration integer DEFAULT NULL`, `input_execution_finished_at timestamptz DEFAULT now()` | — | `sendFSMEvent(deps, fsm_instance_id, fsm_instance_id_fsm_type, fsm_instance_id_fsm_version, send_to_parent_queue_id, send_to_parent_queue_type, send_to_parent_queue_id_event_name, event_name, event_action_type, event_data, event_delay)` | `fsm-instance.ts` |
| `fsm_core.get_fsm_data_resolve_state_value_v2` | `input_fsm_id text` | `resolve_state_value_v2` | `getFSMDataAndResolveStateValue(deps, id)` | `fsm-instance.ts` |
| `fsm_core.archive_event_from_fsm_type_worker_v2` | `remove_from_current_fsm_instance_queue_id text`, `remove_current_queue_msg_id bigint`, `to_be_removed_schedule_queue_msg_ids jsonb`, `to_be_removed_promise_queue_msg_ids jsonb`, `to_be_added_schedule_queue_data jsonb`, `to_be_added_promise_queue_data jsonb`, `input_total_schedule_queue_data jsonb`, `input_total_promise_queue_data jsonb`, `fsm_instance_data_save_fsm_status jsonb`, `fsm_instance_data_save_fsm_state jsonb`, `fsm_instance_data_save_fsm_context jsonb`, `fsm_instance_data_save_fsm_xstate_state jsonb` | `cancel_event_for_fsm_promise_type_worker_v2`, `send_event_to_fsm_promise_queue_from_fsm_instance_id_v2`, `send_event_to_fsm_queue_with_event_logs_v2` | `archive_event_from_fsm_type_worker(deps, remove_from_current_fsm_instance_queue_id, remove_current_queue_msg_id, remove_schedule_queue_msg_ids, remove_promise_queue_msg_ids, input_schedule_queue_data, input_promise_queue_data, total_schedule_queue_data, total_promise_queue_data, fsm_instance_data_save_fsm_status, fsm_instance_data_save_fsm_state, fsm_instance_data_save_fsm_context, fsm_instance_data_save_fsm_xstate_state)` | `fsm-instance.ts` |
| `fsm_core.archive_event_from_fsm_promise_type_worker_v2` | `input_promise_queue_name text`, `input_promise_queue_type text`, `input_promise_queue_version text`, `input_promise_queue_msg_id bigint`, `input_event_name text`, `input_event_action_type text`, `input_event_data jsonb`, `input_event_delay integer`, `input_send_to_parent_queue_id uuid`, `input_send_to_parent_queue_id_event_name text`, `input_execution_started_at timestamptz`, `input_execution_duration integer`, `input_execution_finished_at timestamptz`, `input_event_status text`, `input_event_output jsonb`, `input_error_message text` | `send_event_to_fsm_queue_with_event_logs_v2` | `archive_event_from_fsm_promise_type_worker(deps, promise_queue_name, promise_queue_type, promise_queue_version, promise_queue_msg_id, event_name, event_action_type, event_data, event_delay, send_to_parent_queue_id, send_to_parent_queue_id_event_name, execution_started_at, execution_duration, execution_finished_at, event_status, event_output, error_message)` | `fsm-instance.ts` |
| `fsm_core.lock_fsm_instance` | `p_fsm_instance_id uuid`, `p_locked_by text` | — | `tryFSMDBLock(deps, fsmInstanceId)` | `fsm-instance-lock.ts` |
| `fsm_core.unlock_fsm_instance` | `p_fsm_instance_id uuid` | — | `releaseFSMDBLock(deps, fsmInstanceId)` | `fsm-instance-lock.ts` |
| `fsm_core.create` *(pgmq)* | `queue_name text` | — | `createPgmqQueue(deps, queueName)` | `queue.ts` |
| `fsm_core.read` *(pgmq)* | `queue_name text`, `vt integer`, `qty integer` | — | `readMessage(deps, queueName, vt)` *(hardcodes qty=1)* | `queue.ts` |
| `fsm_core.delete` *(pgmq)* | `queue_name text`, `msg_id bigint` | — | `deleteMessage(deps, queueName, msgId)` | `queue.ts` |
| `fsm_core.archive` *(pgmq, single)* | `queue_name text`, `msg_id bigint` | — | `archiveMessage(deps, queueName, msgId)` | `queue.ts` |
| `fsm_core.list_queues` *(pgmq)* | — | — | `pgmqQueueExists(deps, queueName)` *(filters in TS)* | `queue.ts` |

---

## Table 2: TypeScript Functions Not Directly Mapped to a PG Function

These TypeScript functions do not wrap a single PostgreSQL function. They either execute raw SQL against tables directly or call multiple PG functions.

| TypeScript Function | TS File | PostgreSQL Interaction | Notes |
|---|---|---|---|
| `isFSMInstancePresent(deps, id)` | `fsm-instance.ts` | Raw `SELECT id FROM fsm_core.fsm_instance WHERE id = $1` | Direct table query; no PG function |
| `getFSMData(deps, id)` | `fsm-instance.ts` | Raw `SELECT * FROM fsm_core.fsm_instance WHERE id = $1` | Direct table query; no PG function |

---

## Table 3: Gap — PostgreSQL Functions With No TypeScript Wrapper

### v2 Orchestration Functions

| PostgreSQL Function | PG Input Arguments | Child PG Functions Called |
|---|---|---|
| `fsm_core.macrostep_v2` | `event_name text`, `p_state_value text[]`, `fsm_name_param text`, `fsm_version_param text` | `select_all_transitions_v2`, `select_transitions_with_guard_eval_v2`, `microstep_v2` |
| `fsm_core.fsm_worker_v2` | `event_name text`, `p_state_value jsonb`, `fsm_name_param text`, `fsm_version_param text` | `resolve_state_value_v2`, `macrostep_v2` |
| `fsm_core.select_transitions_with_guard_eval_v2` | `input_all_transitions fsm_core.fsm_transitions[]` | — |
| `fsm_core.send_event_to_promise_queue_with_event_logs_v2` | `input_promise_queue_name text`, `input_promise_fn_name text`, `input_promise_queue_type text`, `input_promise_queue_version text`, `input_send_to_parent_queue_id uuid`, `input_send_to_parent_queue_type text`, `input_send_to_parent_queue_id_event_name text`, `input_event_name text`, `input_event_action_type text`, `input_event_data jsonb`, `input_event_delay integer DEFAULT 0`, `input_event_status text DEFAULT 'ACTIVE'`, `input_event_output jsonb DEFAULT '{}'`, `input_error_message text DEFAULT NULL`, `input_execution_started_at timestamptz DEFAULT now()`, `input_execution_duration integer DEFAULT NULL`, `input_execution_finished_at timestamptz DEFAULT now()` | — |
| `fsm_core.cancel_event_for_fsm_promise_type_worker_v2` | `promise_type_worker_name text`, `queue_msg_id bigint` | `send_event_to_fsm_promise_queue_from_fsm_instance_id_v2` |
| `fsm_core.send_event_to_fsm_queue_from_fsm_instance_id_v2` | `event_name text`, `event_input jsonb`, `id text`, `fsm_type text`, `fsm_version text`, `send_to_parent_queue_id uuid`, `send_to_parent_queue_type text`, `send_to_parent_queue_id_event_name text` | `send_event_to_fsm_queue_with_event_logs_v2` |
| `fsm_core.send_event_to_promise_queue_from_fsm_instance_id_v2` | `event_name text`, `event_input jsonb`, `id text`, `promise_queue_name text`, `promise_queue_type text`, `promise_queue_version text`, `send_to_parent_queue_id uuid`, `send_to_parent_queue_id_event_name text` | `send_event_to_promise_queue_with_event_logs_v2` |
| `fsm_core.send_event_to_queue_from_fsm_instance_id_v2` | `event_name text`, `event_input jsonb`, `id text`, `queue_type text`, `queue_name text`, `queue_version text`, `send_to_parent_queue_id uuid`, `send_to_parent_queue_id_event_name text` | `send_event_to_fsm_queue_from_fsm_instance_id_v2`, `send_event_to_promise_queue_from_fsm_instance_id_v2` |

### PGMQ Wrappers With No TS Equivalent

| PostgreSQL Function | PG Input Arguments |
|---|---|
| `fsm_core.drop_queue` | `queue_name text` |
| `fsm_core.pop` | `queue_name text` |
| `fsm_core.purge_queue` | `queue_name text` |
| `fsm_core.send` *(pgmq)* | `queue_name text`, `msg jsonb`, `delay integer DEFAULT 0` |
| `fsm_core.set_vt` | `queue_name text`, `msg_id bigint`, `vt_offset integer` |
| `fsm_core.archive` *(pgmq, bulk)* | `queue_name text`, `msg_ids bigint[]` |

### v1 Functions (Superseded by v2 — No TS Wrappers by Design)

See [pg-v1-functions.md](./pg-v1-functions.md) for the full list of 21 v1 functions.

### v2 Internal PG Helpers (Called Only Within PG — Not Intended for TS)

| PostgreSQL Function | PG Input Arguments | Child PG Functions Called |
|---|---|---|
| `fsm_core.fsm_get_initial_state_nodes_v2` | `p_fsm_name text`, `p_fsm_version text`, `p_state_path ltree` | `sanitize_text_to_ltree` |
| `fsm_core.fsm_get_initial_state_nodes_with_ancestors_v2` | `p_fsm_name text`, `p_fsm_version text`, `p_state_path ltree` | `fsm_get_initial_state_nodes_v2`, `get_proper_ancestors` |
| `fsm_core.fsm_get_all_state_nodes_v2` | `p_state_paths text[]`, `p_fsm_name text`, `p_fsm_version text` | `fsm_get_initial_state_nodes_with_ancestors_v2`, `sanitize_text_to_ltree` |
| `fsm_core.get_exit_actions_v2` | `p_state_paths text[]`, `p_fsm_name text`, `p_fsm_version text` | — |
| `fsm_core.compute_child_exit_set_v2` | `transition_domain_lca ltree`, `state_node_set ltree[]` | — |
| `fsm_core.compute_full_exit_set_v2` | `transition_record fsm_core.fsm_transitions`, `state_node_set text[]` | `compute_child_exit_set_v2`, `sanitize_text_array_to_ltree_array` |
| `fsm_core.compute_exit_actions_v2` | `transition_record fsm_core.fsm_transitions`, `p_state_node_set text[]`, `p_fsm_name text`, `p_fsm_version text` | `compute_full_exit_set_v2`, `get_exit_actions_v2` |
| `fsm_core.get_initial_actions_v2` | `p_state_paths text[]`, `p_fsm_name text`, `p_fsm_version text` | — |
| `fsm_core.get_entry_actions_v2` | `p_state_paths text[]`, `p_fsm_name text`, `p_fsm_version text` | — |
| `fsm_core.get_descendant_states_for_entry_v2` | `input_state_id text`, `fsm_name_param text`, `fsm_version_param text` | `get_ancestor_states_for_entry_v2`, `get_descendant_states_for_entry_v2` (recursive), `get_proper_ancestors`, `sanitize_text_to_ltree` |
| `fsm_core.get_ancestor_states_for_entry_v2` | `ancestors text[]`, `reentrancy_domain text`, `fsm_name_param text`, `fsm_version_param text` | `get_descendant_states_for_entry_v2`, `sanitize_text_to_ltree` |
| `fsm_core.compute_entry_actions_v2` | `transition_record fsm_core.fsm_transitions`, `fsm_name_param text`, `fsm_version_param text`, `is_initial_transition boolean` | `get_ancestor_states_for_entry_v2`, `get_descendant_states_for_entry_v2`, `get_entry_actions_v2`, `get_initial_actions_v2`, `resolve_state_value_v2`, `sql_lca_from_array` |
| `fsm_core.test_event_transition_for_entry_v2` | `event_name text`, `fsm_name_param text`, `fsm_version_param text` | `compute_entry_actions_v2` |

### Pure Internal Utility Helpers (JSON / LTREE — PG Only)

| PostgreSQL Function | PG Input Arguments | Child PG Functions Called |
|---|---|---|
| `fsm_core.path_string_to_jsonb` | `path text` | `path_string_to_jsonb` (recursive), `jsonb_deep_merge` |
| `fsm_core.jsonb_deep_merge` | `a jsonb`, `b jsonb` | `jsonb_deep_merge` (recursive) |
| `fsm_core.build_nested_json_recursive` | `paths text[]` | `jsonb_deep_merge`, `path_string_to_jsonb` |
| `fsm_core.jsonb_all_paths` | `j jsonb`, `prefix text DEFAULT ''` | `jsonb_all_paths` (recursive) |
| `fsm_core.test_jsonb_roundtrip` | `input_jsonb jsonb` | `jsonb_all_paths`, `build_nested_json_recursive` |
| `fsm_core.remove_hashtag_from_text` | `input_text text` | — |
| `fsm_core.sanitize_text_to_ltree` | `input_text text` | — |
| `fsm_core.sanitize_text_array_to_ltree_array` | `input_array text[]` | `sanitize_text_to_ltree` |
| `fsm_core.sanitize_text_array_to_ltree_text_array` | `input_array text[]` | `sanitize_text_to_ltree` |
| `fsm_core.sql_lca_from_array` | `paths ltree[]` | — |
| `fsm_core.get_proper_ancestors_ltree` | `state_path_ltree ltree`, `to_state_path_ltree ltree` | — |
| `fsm_core.get_proper_ancestors` | `state_path_ltree text`, `to_state_path_ltree text` | — |
| `fsm_core.sql_lca_for_transition` | `transition jsonb` | `sanitize_text_to_ltree`, `sanitize_text_array_to_ltree_array`, `sql_lca_from_array` |
