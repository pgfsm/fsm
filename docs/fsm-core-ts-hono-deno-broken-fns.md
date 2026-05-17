# fsm-core-ts-hono-deno — Broken Functions After fsm-core-db-ts Rename

Functions broken in `apps/fsm-core-ts-hono-deno/` due to renames applied in `apps/fsm-core-db-ts/src/`.

| Old Name | New Name | File | Import Line | Call / Mock Line(s) | Status |
|---|---|---|---|---|---|
| `sendFSMEvent` | `sendEventToFsmQueueWithEventLogs` | `routes/fsm/fsm.handlers.ts` | L16 | L109 | Fixed |
| `createFSMInstanceFromName` | `createFsmInstanceFromName` | `routes/fsm/fsm.test.ts` | L8 (comment), L29 (mock def), L37 (import) | L123, L135, L146, L157, L171 | Fixed |
| `sendFSMEvent` | `sendEventToFsmQueueWithEventLogs` | `routes/fsm/fsm.test.ts` | L8 (comment), L30 (mock def), L37 (import) | L219, L233, L245 | Fixed |

> `isFSMInstancePresent` and `pgmqQueueExists` are unaffected — they are not renamed.
