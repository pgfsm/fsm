# ADR-001: Do Not Use PostgreSQL Row Security Policies (RLS) in fsm_core

**Status:** Accepted **Date:** 2026-06-08

---

## Context

PostgreSQL's Row Level Security (RLS) feature allows attaching `CREATE POLICY`
rules to tables so that each row is filtered based on the current database role.
When RLS is enabled on a table, every query against that table is silently
filtered by the active policy — providing database-enforced, per-row access
control.

The question arose: should `fsm_core` enable RLS on its internal tables to
enforce row-level access control?

Key facts about the `fsm_core` access model:

- All behavior is exposed through PL/pgSQL functions (e.g.,
  `create_fsm_instance`, `send_event_to_fsm`, `get_fsm_instance_state`). No
  table is directly accessible to application users.
- Tables (`fsm_type`, `fsm_instance`, `fsm_event`, etc.) are internal
  implementation details — callers interact only with functions.
- Functions use `SECURITY DEFINER`, meaning they execute as the extension owner,
  not the calling role. Row access always happens as the owner, bypassing any
  per-role filtering.
- Tenant/user isolation is enforced at the API layer
  (`apps/fsm-core-ts-hono-deno/`) and within function logic, not at the database
  row level.

---

## Decision

We will **not** use `CREATE POLICY` / Row Level Security on any tables in
`fsm_core`.

---

## Consequences

### Positive

- **No per-row evaluation overhead** — RLS policies are evaluated for every
  qualifying row in every query. Since `fsm_core` functions query internal
  tables heavily, adding policies would impose a constant runtime cost with no
  security benefit.
- **Single access-control layer** — Security stays at the function boundary
  (`GRANT EXECUTE` on specific functions). Two overlapping layers (function
  ACL + RLS) would add complexity without adding protection.
- **Simpler mental model** — "Access to `fsm_core` = ability to call its
  functions." No hidden row filtering to reason about when debugging.
- **No silent lockout risk** — A misconfigured `USING` clause in an RLS policy
  returns zero rows without an error, making bugs extremely hard to diagnose.
  This risk is eliminated entirely.

### Negative / Trade-offs

- If a future change directly exposes a table (e.g., a Supabase PostgREST view
  or a raw `SELECT` grant), there are no row-level guards in place. Such an
  exposure must be caught at code review.
- Multi-tenant row isolation remains the responsibility of the application layer
  and function logic.

---

## Alternatives Considered

| Option                                                       | Why Not Selected                                                                                                                                                                                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enable RLS on all `fsm_core` tables                          | Tables are not directly accessible to callers; `SECURITY DEFINER` functions already execute as the extension owner, bypassing any per-role RLS policy. Adding RLS would duplicate access guards and add query overhead with no security gain.        |
| Enable RLS on `fsm_instance` only (per-tenant isolation)     | FSM instances are already scoped by `fsm_name` inside function logic. Application-layer isolation (API auth + request scoping) is the correct enforcement point; a DB-level policy would add overhead and a second, inconsistent isolation boundary. |
| Superuser bypass makes RLS ineffective for privilege control | PostgreSQL superusers and roles with `BYPASSRLS` always bypass policies. Since `fsm_core` runs as a superuser-owned extension, RLS cannot be used for privilege-elevation protection in this context.                                                |

---

## Sources

- PostgreSQL Documentation — Row Security Policies:
  https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- PostgreSQL Documentation — CREATE POLICY:
  https://www.postgresql.org/docs/current/sql-createpolicy.html
