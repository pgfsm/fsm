# Naming Suggestions — fsm-core-worker-ts

## Status

**Sections 1, 2, 3, 5 applied ✅ — Section 4 still open ❌**

- Section 1 (types.ts fields): ✅ Applied — types now derived from DB composite
  types
- Section 2 (macrostepV2 rename): ✅ Applied — `fsmworker-helper.ts:102` and
  `index.ts:5`
- Section 3 (macrostepV2 parameter names): ✅ Applied —
  `fsmworker-helper.ts:106–109`
- Section 4 (`FSMPromiseArchiveData` fields): ❌ Open — see below
- Section 5 (runtime bug in `fsmpromiseworker-helper.ts`): ✅ Fixed — resolved
  by Section 1

---

This document lists naming inconsistencies found in
`apps/fsm-core-worker-ts/src/` relative to the project conventions in CLAUDE.md.

## Convention recap

- TypeScript function and variable names: **camelCase**
- TypeScript interface/type fields: **camelCase** (snake_case is reserved for PG
  function parameters passed through DB wrappers)
- PG-derived function parameters (e.g. `input_fsm_name`) keep their PG names
  only at the DB wrapper call sites, not in pure TS logic
- Exported function names that correspond to PG functions: strip `_v1`/`_v2`
  suffix and camelCase (e.g. `macrostep_v2` → `macrostepV2`)

---

## 1. `src/types.ts` — interface fields should be camelCase ✅ Applied

`types.ts` now derives both types directly from the generated DB composite types
(applied 2026-05-29):

```ts
export type FsmQueueMessageEventData =
  Database["fsm_core"]["CompositeTypes"]["fsm_event_data_v2"];
// { eventType, eventPayload, actionType }

export type FsmQueueMessage =
  Database["fsm_core"]["CompositeTypes"]["fsm_queue_msg_data_v2"];
// { eventData, queueId, queueType, queueVersion,
//   sendToParentQueueId, sendToParentQueueType, sendToParentQueueIdEventName,
//   queueMsgId, queueMsgDelay, queueFnName }
```

All callers updated: `fsmworker-helper.ts` (`eventData?.eventType`,
`eventData?.eventPayload`), `fsmpromiseworker-helper.ts` (`sendToParentQueueId`,
`sendToParentQueueIdEventName`, `eventData?.actionType`,
`eventData?.eventPayload`).

---

## 2. `src/fsmworker-helper.ts` — exported function name ✅ Applied

| Was            | Now           | Location                                |
| -------------- | ------------- | --------------------------------------- |
| `macrostep_v2` | `macrostepV2` | `fsmworker-helper.ts:102`, `index.ts:5` |

---

## 3. `src/fsmworker-helper.ts` — internal function parameter names ✅ Applied

All parameters of `macrostepV2` are now camelCase:

| Param                | Location |
| -------------------- | -------- |
| `fsmInstanceRow`     | line 106 |
| `resolvedStateValue` | line 107 |
| `fsmName`            | line 108 |
| `fsmVersion`         | line 109 |

---

## 4. `src/fsmpromiseworker-helper.ts` — `FSMPromiseArchiveData` type fields ❌ Open

`FSMPromiseArchiveData` is a TypeScript-only return type with all snake_case
fields. It should follow camelCase.

| Current field                    | Suggested field            |
| -------------------------------- | -------------------------- |
| `promise_queue_name`             | `promiseQueueName`         |
| `promise_queue_type`             | `promiseQueueType`         |
| `promise_queue_version`          | `promiseQueueVersion`      |
| `msg_id`                         | `msgId`                    |
| `event_name`                     | `eventName`                |
| `event_action_type`              | `eventActionType`          |
| `event_data`                     | `eventData`                |
| `event_delay`                    | `eventDelay`               |
| `send_to_parent_queue_id`        | `sendToParentQueueId`      |
| `send_to_parent_queue_id_msg_id` | `sendToParentQueueIdMsgId` |
| `execution_started_at`           | `executionStartedAt`       |
| `execution_duration`             | `executionDuration`        |
| `execution_finished_at`          | `executionFinishedAt`      |
| `event_output`                   | `eventOutput`              |
| `event_status`                   | `eventStatus`              |
| `error_message`                  | `errorMessage`             |

**Impact:** `processFSMPromiseQueueMessage` returns this type; all callers (e.g.
`fsmpromiseworker.ts`) that destructure the result must be updated together.

---

## 5. `src/fsmpromiseworker-helper.ts` — runtime bug ✅ Fixed

Fixed as part of the Section 1 camelCase migration (2026-05-29):

```ts
// Before (returned undefined at runtime — fields didn't exist on FsmQueueMessage)
const send_to_parent_queue_id = msgData.send_to_parent_queue_id ?? "";
const send_to_parent_queue_id_msg_id = msgData.sendToParentQueueIdMsgId ?? "";
const event_name_base = msgData.sendToParentQueueIdEventName ?? "";
const event_action_type = msgData.event_data?.action_type ?? "";
const event_data_payload = msgData.event_data?.event_payload ?? null;

// After
const send_to_parent_queue_id = msgData.sendToParentQueueId ?? "";
const send_to_parent_queue_id_msg_id = msgData.queueMsgId?.toString() ?? "";
const event_name_base = msgData.sendToParentQueueIdEventName ?? "";
const event_action_type = msgData.eventData?.actionType ?? "";
const event_data_payload = msgData.eventData?.eventPayload ?? null;
```

---

## Notes

- Section 4 (`FSMPromiseArchiveData`) is the only remaining open item — rename
  fields and update the caller in `fsmpromiseworker.ts` atomically.
