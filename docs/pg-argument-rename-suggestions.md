# PostgreSQL `p_*` Argument Rename Suggestions

## Convention

Replace the `p_` prefix with `input_` on all function parameters.

**Why:** The newer functions in this schema (`send_event_to_fsm_queue_with_event_logs_v2`, `create_fsm_instance_from_name_v2`, `archive_event_from_fsm_*`, etc.) already use `input_*` consistently. The `p_` prefix is a legacy PL/pgSQL convention for avoiding column-name collisions; `input_*` is more self-documenting and matches the established pattern in this codebase.

**Rule:** `p_<name>` → `input_<name>`

---

## Lock Functions

**File:** `20250119144637_fsm_instance_lock.sql`

| Function | Current Param | Type | Suggested Param |
|---|---|---|---|
| `fsm_core.lock_fsm_instance` | `p_fsm_instance_id` | `uuid` | `input_fsm_instance_id` |
| `fsm_core.lock_fsm_instance` | `p_locked_by` | `text` | `input_locked_by` |
| `fsm_core.unlock_fsm_instance` | `p_fsm_instance_id` | `uuid` | `input_fsm_instance_id` |

---

## State Value Functions — v2

**File:** `20241221134661_fsm_state_values_v2.sql`

| Function | Current Param | Type | Suggested Param |
|---|---|---|---|
| `fsm_core.fsm_get_initial_state_nodes_v2` | `p_fsm_name` | `text` | `input_fsm_name` |
| `fsm_core.fsm_get_initial_state_nodes_v2` | `p_fsm_version` | `text` | `input_fsm_version` |
| `fsm_core.fsm_get_initial_state_nodes_v2` | `p_state_path` | `ltree` | `input_state_path` |
| `fsm_core.fsm_get_initial_state_nodes_with_ancestors_v2` | `p_fsm_name` | `text` | `input_fsm_name` |
| `fsm_core.fsm_get_initial_state_nodes_with_ancestors_v2` | `p_fsm_version` | `text` | `input_fsm_version` |
| `fsm_core.fsm_get_initial_state_nodes_with_ancestors_v2` | `p_state_path` | `ltree` | `input_state_path` |
| `fsm_core.fsm_get_all_state_nodes_v2` | `p_state_paths` | `text[]` | `input_state_paths` |
| `fsm_core.fsm_get_all_state_nodes_v2` | `p_fsm_name` | `text` | `input_fsm_name` |
| `fsm_core.fsm_get_all_state_nodes_v2` | `p_fsm_version` | `text` | `input_fsm_version` |

---

## Exit Action Functions — v2

**File:** `20241222134632_fsm_exit_actions_v2.sql`

| Function | Current Param | Type | Suggested Param |
|---|---|---|---|
| `fsm_core.get_exit_actions_v2` | `p_state_paths` | `TEXT[]` | `input_state_paths` |
| `fsm_core.get_exit_actions_v2` | `p_fsm_name` | `TEXT` | `input_fsm_name` |
| `fsm_core.get_exit_actions_v2` | `p_fsm_version` | `TEXT` | `input_fsm_version` |
| `fsm_core.compute_exit_actions_v2` | `p_state_node_set` | `TEXT[]` | `input_state_node_set` |
| `fsm_core.compute_exit_actions_v2` | `p_fsm_name` | `TEXT` | `input_fsm_name` |
| `fsm_core.compute_exit_actions_v2` | `p_fsm_version` | `TEXT` | `input_fsm_version` |

---

## Entry Action Functions — v2

**File:** `20241222134642_fsm_entry_actions_v2.sql`

| Function | Current Param | Type | Suggested Param |
|---|---|---|---|
| `fsm_core.get_initial_actions_v2` | `p_state_paths` | `TEXT[]` | `input_state_paths` |
| `fsm_core.get_initial_actions_v2` | `p_fsm_name` | `TEXT` | `input_fsm_name` |
| `fsm_core.get_initial_actions_v2` | `p_fsm_version` | `TEXT` | `input_fsm_version` |
| `fsm_core.get_entry_actions_v2` | `p_state_paths` | `TEXT[]` | `input_state_paths` |
| `fsm_core.get_entry_actions_v2` | `p_fsm_name` | `TEXT` | `input_fsm_name` |
| `fsm_core.get_entry_actions_v2` | `p_fsm_version` | `TEXT` | `input_fsm_version` |

---

## Macrostep Functions — v2

**File:** `20241222134842_fsm_macrostep_v2.sql`

| Function | Current Param | Type | Suggested Param |
|---|---|---|---|
| `fsm_core.select_all_transitions_v2` | `p_state_value` | `TEXT[]` | `input_state_value` |
| `fsm_core.macrostep_v2` | `p_state_value` | `TEXT[]` | `input_state_value` |
| `fsm_core.fsm_worker_v2` | `p_state_value` | `JSONB` | `input_state_value` |


> v1 function rename suggestions have been moved to [pg-v1-argument-rename-suggestions.md](./pg-v1-argument-rename-suggestions.md).
