# fsm_core

A finite state machine engine that runs entirely inside PostgreSQL.

## What it does

`fsm_core` lets you define, run, and persist state machines as first-class database objects. States, transitions, guards, and event history all live in PostgreSQL — no application-side orchestration layer required.

A state machine is defined once as a JSON schema, compiled into the database, and then driven by sending events through SQL functions. The database enforces which transitions are valid, records every event, and keeps each instance at exactly one state at a time.

## Where it is helpful

- **Workflow orchestration** — model multi-step business processes (approvals, onboarding, order fulfilment) entirely in the database so any client or service can participate without duplicating logic
- **Audit trails** — every state change and event is persisted automatically; replay or inspect the full history of any instance with a query
- **Concurrency safety** — advisory locks prevent two callers from advancing the same instance simultaneously, without requiring application-level coordination
- **Multiple execution models** — drive machines synchronously (direct call), asynchronously via a pgmq-backed worker queue, or through a promise/callback pattern — all from the same schema
- **Supabase compatible** — ships with RLS-aware grants and PostgREST-friendly function signatures so it works out of the box as a Supabase backend

## Requirements

| Dependency | Minimum version | Notes |
|---|---|---|
| PostgreSQL | 15 | |
| ltree | 1.2 | bundled with PostgreSQL |
| pgmq | 1.4.4 | must be installed separately |
| pg_jsonschema | 0.3.3 | installed automatically into the `fsm_core` schema |

## Installation

### Via PGXN

```bash
pgxn install fsm_core
```

Then in your database:

```sql
CREATE EXTENSION ltree;
CREATE EXTENSION pgmq;
CREATE EXTENSION fsm_core;
```

### Manual

Download the PGXN zip (or build it locally with `npm run pgxnBuildAndPublish`) and apply the SQL files inside in version order using `psql` or your migration tool of choice.

## Reference

- [PG→TS function mapping](./docs/pg-ts-function-mapping.md)
- [Release workflow & migration naming](./docs/release.md)
- [Development setup](./docs/development.md)
- [Extension creation ADR](./docs/extension-creation-approach-adr.md)
