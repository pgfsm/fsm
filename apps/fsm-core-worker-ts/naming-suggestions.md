# Naming Suggestions — fsm-core-worker-ts

This document lists naming inconsistencies found in `apps/fsm-core-worker-ts/src/` relative to the project conventions in CLAUDE.md.

## Convention recap

- TypeScript function and variable names: **camelCase**
- TypeScript interface/type fields: **camelCase** (snake_case is reserved for PG function parameters passed through DB wrappers)
- PG-derived function parameters (e.g. `input_fsm_name`) keep their PG names only at the DB wrapper call sites, not in pure TS logic
- Exported function names that correspond to PG functions: strip `_v1`/`_v2` suffix and camelCase (e.g. `macrostep_v2` → `macrostepV2`)

---

## 1. `src/types.ts` — interface fields should be camelCase

All fields in `FsmQueueMessage` and `FsmQueueMessageEventData` use snake_case. These are TypeScript-only types (not direct PG function parameter structs), so they should follow camelCase.

| Current field | Suggested field | Interface |
|---|---|---|
| `event_type` | `eventType` | `FsmQueueMessageEventData` |
| `event_payload` | `eventPayload` | `FsmQueueMessageEventData` |
| `action_type` | `actionType` | `FsmQueueMessageEventData` |
| `event_data` | `eventData` | `FsmQueueMessage` |
| `fsm_instance_id` | `fsmInstanceId` | `FsmQueueMessage` |
| `fsm_instance_id_fsm_type` | `fsmInstanceIdFsmType` | `FsmQueueMessage` |
| `fsm_instance_id_fsm_version` | `fsmInstanceIdFsmVersion` | `FsmQueueMessage` |
| `send_to_parent_queue_id` | `sendToParentQueueId` | `FsmQueueMessage` |
| `send_to_parent_queue_type` | `sendToParentQueueType` | `FsmQueueMessage` |
| `send_to_parent_queue_id_msg_id` | `sendToParentQueueIdMsgId` | `FsmQueueMessage` |
| `send_to_parent_queue_id_event_name` | `sendToParentQueueIdEventName` | `FsmQueueMessage` |

**Impact:** All callers that access these fields must be updated. Files that use `FsmQueueMessage` fields:
- `src/fsmworker-helper.ts` — `eventData.event_data?.event_type`, `eventData.event_data?.event_payload`
- `src/fsmworker.ts` — message destructuring
- `src/fsmpromiseworker.ts` — message destructuring
- `src/fsmpromiseworker-helper.ts` — message fields

---

## 2. `src/fsmworker-helper.ts` — exported function name

| Current | Suggested | Reason |
|---|---|---|
| `macrostep_v2` (line 102) | `macrostepV2` | TS functions use camelCase. `_v2` suffix uses snake_case which is PG convention, not TS |

The corresponding export in `src/index.ts` and any callers (e.g. `src/fsmworker.ts`) must be updated together.

---

## 3. `src/fsmworker-helper.ts` — internal function parameter names

The parameters of `macrostep_v2` mix camelCase and snake_case inconsistently. All are internal TS variables and should be camelCase.

| Current param | Suggested param | Line |
|---|---|---|
| `fsm_instance_row` | `fsmInstanceRow` | 106 |
| `resolved_state_value` | `resolvedStateValue` | 107 |
| `fsm_name` | `fsmName` | 108 |
| `fsm_version` | `fsmVersion` | 109 |
| `fsmModuleDefinition` | (already camelCase — no change) | 110 |
| `queueName` | (already camelCase — no change) | 104 |

---

## Notes

- The `types.ts` rename has the largest blast radius and should be done as a single atomic change with a grep-replace across all 4 affected files.
- The `macrostep_v2` → `macrostepV2` rename is safe to do independently since it is only called from `src/fsmworker.ts` and exported from `src/index.ts`.
- Parameter renames inside `macrostep_v2` are internal-only and carry no external impact.
