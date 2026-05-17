# fsm-core-worker-ts — Broken Functions After fsm-core-db-ts Rename

Functions broken in `apps/fsm-core-worker-ts/src/` due to renames applied in `apps/fsm-core-db-ts/src/`.

| Old Name | New Name | File | Import Line | Call Line(s) | Status |
|---|---|---|---|---|---|
| `createFSMInstanceFromName` | `createFsmInstanceFromName` | `createAndStartFSMWorker.ts` | L3 | L19 | Fixed |
| `tryFSMDBLock` | `lockFsmInstance` | `fsmworker-lock.ts` | L2 | L15 | Fixed |
| `releaseFSMDBLock` | `unlockFsmInstance` | `fsmworker-lock.ts` | L2 | L20 | Fixed |
| `archive_event_from_fsm_type_worker` | `archiveEventFromFsmTypeWorker` | `fsmworker.ts` | L8 | L121 | Fixed |
| `getFSMDataAndResolveStateValue` | `getFsmDataResolveStateValue` | `fsmworker.ts` | L9 | L99 | Fixed |
| `archive_event_from_fsm_promise_type_worker` | `archiveEventFromFsmPromiseTypeWorker` | `fsmpromiseworker.ts` | L5 | L86 | Fixed |
| `getFSMDataAndResolveStateValue` | `getFsmDataResolveStateValue` | `fsmpromiseworker.ts` | L5 | L66 (commented) | Fixed |
| `performMicrostep` | `microstep` | `fsmworker-helper.ts` | L15 | L226 | Fixed |
| `selectTransitions` | `selectAllTransitions` | `fsmworker-helper.ts` | L16 | L158 | Fixed |
