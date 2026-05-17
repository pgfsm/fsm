# fsm-core-worker-ts — Broken Functions After fsm-core-db-ts Rename

Functions broken in `apps/fsm-core-worker-ts/src/` due to renames applied in `apps/fsm-core-db-ts/src/`.

| Old Name | New Name | File | Import Line | Call Line(s) |
|---|---|---|---|---|
| `createFSMInstanceFromName` | `createFsmInstanceFromName` | `createAndStartFSMWorker.ts` | L3 | L19 |
| `tryFSMDBLock` | `lockFsmInstance` | `fsmworker-lock.ts` | L2 | L15 |
| `releaseFSMDBLock` | `unlockFsmInstance` | `fsmworker-lock.ts` | L2 | L20 |
| `archive_event_from_fsm_type_worker` | `archiveEventFromFsmTypeWorker` | `fsmworker.ts` | L8 | L121 |
| `getFSMDataAndResolveStateValue` | `getFsmDataResolveStateValue` | `fsmworker.ts` | L9 | L99 |
| `archive_event_from_fsm_promise_type_worker` | `archiveEventFromFsmPromiseTypeWorker` | `fsmpromiseworker.ts` | L5 | L86 |
| `getFSMDataAndResolveStateValue` | `getFsmDataResolveStateValue` | `fsmpromiseworker.ts` | L5 | L66 (commented) |
| `performMicrostep` | `microstep` | `fsmworker-helper.ts` | L15 | L226 |
| `selectTransitions` | `selectAllTransitions` | `fsmworker-helper.ts` | L16 | L158 |
