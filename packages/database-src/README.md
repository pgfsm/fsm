# fsm_core

A finite state machine engine that runs entirely inside PostgreSQL.

## What it does

`fsm_core` lets you define, run, and persist state machines as first-class
database objects. States, transitions, guards, and event history all live in
PostgreSQL — no application-side orchestration layer required.

A state machine is defined once as a JSON schema, compiled into the database,
and then driven by sending events through SQL functions. The database enforces
which transitions are valid, records every event, and keeps each instance at
exactly one state at a time.

## Where it is helpful

- **Workflow orchestration** — model multi-step business processes (approvals,
  onboarding, order fulfilment) entirely in the database so any client or
  service can participate without duplicating logic
- **Audit trails** — every state change and event is persisted automatically;
  replay or inspect the full history of any instance with a query
- **Concurrency safety** — advisory locks prevent two callers from advancing the
  same instance simultaneously, without requiring application-level coordination
- **Multiple execution models** — drive machines synchronously (direct call),
  asynchronously via a pgmq-backed worker queue, or through a promise/callback
  pattern — all from the same schema
- **Supabase compatible** — ships with RLS-aware grants and PostgREST-friendly
  function signatures so it works out of the box as a Supabase backend

## Requirements

| Dependency    | Version    | Notes                                                                                                                                                 |
| ------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL    | 15, 16, 17 | managed Postgres works (RDS, Cloud SQL, Azure, Neon, Supabase)                                                                                        |
| ltree         | 1.2        | contrib, ships with PostgreSQL                                                                                                                        |
| pg_cron       | 1.5+       | required: runs the scheduler every 5 seconds. Must be in `shared_preload_libraries`, and fsm_core goes in the database `cron.database_name` names     |
| pgmq          | 1.4.4+     | required: the extension (Supabase, Neon; elsewhere `pgxn install pgmq`, or its SQL-only files from the release in the extension directory)            |
| pg_jsonschema | optional   | when installed into `fsm_core`, loading an FSM also warns about JSON that fails the schema; the compiler validates it anyway. The pgTAP tests need it |

## Installation (SPEC-016)

Each release (`fsm_core-v<version>` tag) publishes, as GitHub release assets:

- `fsm_core--<version>.sql`: the full install, for a new database;
- `fsm_core--<from>--<to>.sql`: the upgrade scripts, one per version;
- `fsm_core-<version>.zip`: the same SQL as a PGXN extension.

### Full install (any Postgres, including managed)

Run it once, in one transaction, as the database owner (on managed Postgres, the
provider's admin login), connected to pg_cron's database:

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f fsm_core--1.2.0.sql
```

It checks the server first (PostgreSQL 15+, ltree, pg_cron and pgmq available,
fsm_core not installed yet), creates those extensions when they're missing,
creates the `fsm_*` roles, and registers the `fsm_schedule_all_pending` pg_cron
job. Creating extensions and roles needs the database owner with `CREATEROLE`,
not a superuser; on PostgreSQL 15+ only the owner may create in `public`.

To upgrade, apply each upgrade script in order, from the installed version
(`SELECT fsm_core.version();`). Each one starts with
`SELECT fsm_core.require_version('<from>');`, so a script applied to the wrong
version fails before changing anything. Migration tools (Flyway, Sqitch,
Supabase migrations) can run them as ordinary migrations.

### Via PGXN

```bash
pgxn install pgmq
pgxn install fsm_core
```

Then, in pg_cron's database, as a superuser:

```sql
CREATE EXTENSION fsm_core CASCADE; -- creates ltree, pgmq and pg_cron too
ALTER EXTENSION fsm_core UPDATE;   -- later, to upgrade
```

### Building and testing the install

```bash
npm run generateBothPgextAndFullsqlscript -- patch       # new version: upgrade + full scripts
npm run buildBothPgextAndFullsqlscript -- --version <v>  # full-release/full-release-<v>/
deno task check:version             # fsm_core.version() matches the migrations
deno task compare:pgext <v> --pg 16    # Docker: plain-SQL install = CREATE EXTENSION
```

## Reference

- [PG→TS function mapping](./docs/reference/pg-ts-function-mapping.md)
- [Release workflow & migration naming](./docs/guides/release.md)
- [Development setup](./docs/guides/development.md)
- [Extension creation ADR](../database-src-extension/docs/adr/extension-creation-approach-qa.md)

## License

[AGPL-3.0-only](./LICENSE). fsm_core is part of the pgfsm engine (SPEC-017),
except its contract files (`fsm.machine.schema.*.json`,
`xstate.machine.schema.json`, `generated/`), which are Apache-2.0. Running it
unmodified needs nothing beyond the AGPL. If you modify it and offer it to users
over a network, you must offer them your modified source (AGPL-3.0 §13). The
generated install SQL starts with an SPDX header saying so. The engine is also
available under a [commercial licence](../../COMMERCIAL.md); the client SDKs and
libraries are Apache-2.0 (see the [root LICENSE](../../LICENSE)).
