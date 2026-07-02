# Limitation: pgmq Queue Name Length (47 characters)

## Root cause

PostgreSQL identifiers are limited to **63 bytes**. pgmq internally prefixes
queue names when creating the backing table, consuming part of that budget:

| Queue type  | Internal table prefix | Prefix length | Max queue name length |
| ----------- | --------------------- | ------------- | --------------------- |
| Standard    | `pgmq_q_`             | 8 chars       | 55 chars              |
| Partitioned | `template_pgmq_q_`    | 16 chars      | **47 chars**          |

pgmq validates against the partitioned limit (the tighter one):

```sql
-- packages/database-src/supabase/schemas/20241218134622_PGMQ_source.sql
IF length(queue_name) > 47 THEN
  RAISE EXCEPTION 'queue name is too long, maximum length is 47 characters';
END IF;
```

## How queue names are built in fsm_core

| FSM type          | Queue name pattern                             | Example                                                        |
| ----------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| `worker` instance | `{fsm_instance_id}` (UUID)                     | `550e8400-e29b-41d4-a716-446655440000` — 36 chars, always safe |
| `promise`         | `{parentFsmName}_{parentFsmVersion}_{fsmName}` | `creditCheck_v01_verifyCredentials`                            |
| `sharedPromise`   | `sharedPromise_{fsmName}_{fsmVersion}`         | `sharedPromise_verifyCredentials_v01`                          |

Source:
`supabase/schemas/20250219134852_archive_from_fsm_instance_worker_v2.sql`

## Where this limits FSM naming

`promise` queues are the tightest: the name combines three segments with two
underscores.

```
{parentFsmName} _ {parentFsmVersion} _ {fsmName}
                                               ^ must total ≤ 47 chars
```

**Budget breakdown for `promise` type:**

| Segment            | Chars used                | Budget consumed |
| ------------------ | ------------------------- | --------------- |
| `parentFsmName`    | variable                  | —               |
| `_` separator      | 1                         | —               |
| `parentFsmVersion` | variable (e.g. `v01` = 3) | —               |
| `_` separator      | 1                         | —               |
| `fsmName`          | variable                  | —               |
| **Total**          | **≤ 47**                  | **hard limit**  |

**Example that hits the limit:**

```
longParentFsmName_v01_longPromiseFsmName
^^^^^^^^^^^^^^^^^     ^^^^^^^^^^^^^^^^^ 
      17 chars    + 3 +      17 chars   = 39 chars (ok)

veryLongParentFsmName_v01_veryLongPromiseName
      21 chars         + 3 +      21 chars   = 47 chars (exactly at limit)

veryLongParentFsmName_v01_veryLongPromiseNameX  ← 48 chars → runtime error
```

## Impact

- The error only surfaces **at runtime** when `pgmq.create()` is called — there
  is no client-side or compile-time validation.
- A failed queue creation causes the entire FSM instance operation to fail with
  a PostgreSQL exception.

## Mitigation

- Keep `fsmName` and `parentFsmName` short — prefer abbreviated identifiers
  (e.g. `ccCheck` over `creditCheck`)
- Keep version strings short — `v1` rather than `v1.0.0`
- Add a naming convention rule: combined promise queue name
  (`parentFsmName + _ + parentFsmVersion + _ + fsmName`) must not exceed 47
  characters
- Future: add a check in the FSM compiler or
  `create_promise_queue_and_send_event_from_fsm_instance_id_v2` to validate
  queue name length before calling `pgmq.create()`
