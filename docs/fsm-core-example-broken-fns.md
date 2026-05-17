# fsm-core-example — Broken Functions After fsm-core-db-ts Rename

Functions broken in `apps/fsm-core-example/` due to renames applied in `apps/fsm-core-db-ts/src/`.

| Old Name | New Name | File | Import Line | Call Line(s) | Status |
|---|---|---|---|---|---|
| `createFSMInstanceFromName` | `createFsmInstanceFromName` | `fsm/creditCheck/v01/fsm_core_journey_test.ts` | L8 | L166 | Fixed |
| `sendFSMEvent` | `sendEventToFsmQueueWithEventLogs` | `fsm/creditCheck/v01/fsm_core_journey_test.ts` | L8 | L111, L182 | Fixed |
| `getFSMDataAndResolveStateValue` | `getFsmDataResolveStateValue` | `fsm/creditCheck/v01/fsm_core_journey_test.ts` | L8 | L26, L64, L130 | Fixed |

> `resolveStateValue` is used in 4 other files (`fsm_core_resolveStateValue_test.ts`, `fsm_core_macrostep_v2_test.ts`, `compare_fsm_resolveState_with_xstate_resolveState.ts`, `compare_fsm_macrostep_v2_with_xstate_transition.ts`) — its name was **not** changed, so those files are unaffected.
