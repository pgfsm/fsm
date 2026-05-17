# PostgreSQL v1 Functions — `p_*` Argument Rename Suggestions

These are rename suggestions for v1 functions only. V1 functions are superseded by v2 and have no TypeScript wrappers — these are provided for completeness. Changes are **not applied** to v1 schema files.

**Rule:** `p_<name>` → `input_<name>`

---

## State Value Functions — v1

**File:** `20241218134661_fsm_state_values_v1.sql`

| Function | Current Param | Type | Suggested Param |
|---|---|---|---|
| `fsm_core.fsm_get_initial_state_nodes_v1` | `p_fsm_name` | `text` | `input_fsm_name` |
| `fsm_core.fsm_get_initial_state_nodes_v1` | `p_fsm_version` | `text` | `input_fsm_version` |
| `fsm_core.fsm_get_initial_state_nodes_v1` | `p_state_path` | `ltree` | `input_state_path` |
| `fsm_core.fsm_get_initial_state_nodes_with_ancestors_v1` | `p_fsm_name` | `text` | `input_fsm_name` |
| `fsm_core.fsm_get_initial_state_nodes_with_ancestors_v1` | `p_fsm_version` | `text` | `input_fsm_version` |
| `fsm_core.fsm_get_initial_state_nodes_with_ancestors_v1` | `p_state_path` | `ltree` | `input_state_path` |
| `fsm_core.fsm_get_all_state_nodes_v1` | `p_state_paths` | `text[]` | `input_state_paths` |
| `fsm_core.fsm_get_all_state_nodes_v1` | `p_fsm_name` | `text` | `input_fsm_name` |
| `fsm_core.fsm_get_all_state_nodes_v1` | `p_fsm_version` | `text` | `input_fsm_version` |

---

## Exit Action Functions — v1

**File:** `20241219134632_fsm_exit_actions_v1.sql`

| Function | Current Param | Type | Suggested Param |
|---|---|---|---|
| `fsm_core.get_exit_actions_v1` | `p_state_paths` | `TEXT[]` | `input_state_paths` |
| `fsm_core.get_exit_actions_v1` | `p_fsm_name` | `TEXT` | `input_fsm_name` |
| `fsm_core.get_exit_actions_v1` | `p_fsm_version` | `TEXT` | `input_fsm_version` |
| `fsm_core.compute_exit_actions_v1` | `p_state_node_set` | `TEXT[]` | `input_state_node_set` |
| `fsm_core.compute_exit_actions_v1` | `p_fsm_name` | `TEXT` | `input_fsm_name` |
| `fsm_core.compute_exit_actions_v1` | `p_fsm_version` | `TEXT` | `input_fsm_version` |

---

## Entry Action Functions — v1

**File:** `20241219134642_fsm_entry_actions_v1.sql`

| Function | Current Param | Type | Suggested Param |
|---|---|---|---|
| `fsm_core.get_initial_actions_v1` | `p_state_paths` | `TEXT[]` | `input_state_paths` |
| `fsm_core.get_initial_actions_v1` | `p_fsm_name` | `TEXT` | `input_fsm_name` |
| `fsm_core.get_initial_actions_v1` | `p_fsm_version` | `TEXT` | `input_fsm_version` |
| `fsm_core.get_entry_actions_v1` | `p_state_paths` | `TEXT[]` | `input_state_paths` |
| `fsm_core.get_entry_actions_v1` | `p_fsm_name` | `TEXT` | `input_fsm_name` |
| `fsm_core.get_entry_actions_v1` | `p_fsm_version` | `TEXT` | `input_fsm_version` |

---

## Macrostep Functions — v1

**File:** `20241219134842_fsm_macrostep_v1.sql`

| Function | Current Param | Type | Suggested Param |
|---|---|---|---|
| `fsm_core.select_all_transitions_v1` | `p_state_value` | `TEXT[]` | `input_state_value` |
| `fsm_core.macrostep_v1` | `p_state_value` | `TEXT[]` | `input_state_value` |
| `fsm_core.fsm_worker_v1` | `p_state_value` | `JSONB` | `input_state_value` |
