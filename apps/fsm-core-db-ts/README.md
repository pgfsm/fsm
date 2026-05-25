# fsm-core-db-ts — Database Access Layer

TypeScript wrappers over the PostgreSQL functions in the `fsm_core` schema. The only layer in the codebase that speaks SQL directly — everything else calls this.

## What it does

- Creates FSM instances (`createFsmInstanceFromName`)
- Sends events to queues (`sendEventToFsmQueueWithEventLogs`)
- Runs microsteps (`microstep`)
- Archives macrostep results (`archiveEventFromFsmTypeWorker`, `archiveEventFromFsmPromiseTypeWorker`)
- Manages pgmq queues (`createPgmqQueue`, `readMessage`, `deleteMessage`)
- Provides advisory lock helpers (`fsm-instance-lock.ts`)

## How it's consumed

Import from the package alias `@fsm/db`:

```typescript
import {
  createFsmInstanceFromName,
  sendEventToFsmQueueWithEventLogs,
  archiveEventFromFsmTypeWorker,
  microstep,
} from "@fsm/db";

import type { DBDeps } from "@fsm/db";
```

Every exported function takes `deps: DBDeps` as its first argument — `DBDeps` wraps the database client and is the only coupling point between TypeScript and PostgreSQL.

## Naming conventions

- TypeScript function names match the PostgreSQL function names with `_v1`/`_v2` suffix stripped and snake_case → camelCase
- The active PG function version is set by `FSM_SCHEMA_FN_VERSION` in `const.ts` (currently `v2`)
- PostgreSQL parameters use the `input_*` prefix (e.g. `input_fsm_name`); TypeScript parameters drop it

See [`docs/pg-ts-function-mapping.md`](../../docs/pg-ts-function-mapping.md) for the full mapping table.

## Key files

| File | Purpose |
|---|---|
| `src/const.ts` | Schema name, function version, sentinel UUID constants |
| `src/custom-type.ts` | `DBDeps` type definition |
| `src/fsm-instance.ts` | Instance lifecycle — create, archive, list |
| `src/fsm-helper.ts` | State resolution, microstep, transition queries |
| `src/fsm-instance-lock.ts` | PG advisory lock helpers |
| `src/queue.ts` | pgmq queue CRUD and message reads |
| `src/database.types.ts` | Auto-generated types from live DB schema (do not edit) |

## Regenerating types

After any PostgreSQL schema change, regenerate `database.types.ts`:

```bash
cd packages/database-src && npm run supabase:gen:types
```
