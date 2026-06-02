# database-src — PostgreSQL Schema & Migrations

The PostgreSQL source of truth for the FSM framework. Contains schema files, migrations, Supabase configuration, and the generated TypeScript types consumed by `fsm-core-db-ts`.

## What it produces

- **Migrations** — timestamped SQL files in `supabase/migrations/` that bring the database to the current state
- **Generated types** — `database.types.ts` auto-generated from the live schema, consumed by `@pgfsm/db`

## Key commands

```bash
# Start local Supabase (PostgreSQL + pgmq + ltree)
npm run supabase:start

# Reset DB and re-run all migrations from scratch
npm run supabase:db:reset

# Generate TypeScript types from the live schema — run after any PG change
npm run supabase:gen:types

# Apply a schema diff: stop → clean volumes → diff → restart → regen types
npm run supabase:restart:with:diff

# Generate a migration file from schema changes
npm run supabase:db:diff:schemafolder:sql
```

## How schema changes work

1. Edit the relevant file in `supabase/schemas/`
2. Run `npm run supabase:db:diff:schemafolder:sql` to generate a new migration under `supabase/migrations/`
3. Run `npm run supabase:gen:types` to regenerate `database.types.ts`
4. Update any TypeScript wrappers in `packages/fsm-core-db-ts/src/` that depend on the changed PG function signatures

Schema files are the source; migrations are their output. Never hand-edit a migration to add schema logic — edit the schema file and diff.

## Manual release

Use `supabase:restart:with:diff:manualrelease` to generate a versioned migration file and bump `package.json`. The filename is computed by `script.ts` based on whether a release file already exists in `supabase/migrations/`.

Pass the bump type via `--bumptype`:

```bash
# patch bump: fsm_core--1.0.0--1.0.1.sql
npm run supabase:restart:with:diff:manualrelease --bumptype=patch

# minor bump: fsm_core--1.0.0--1.1.0.sql
npm run supabase:restart:with:diff:manualrelease --bumptype=minor

# major bump: fsm_core--1.0.0--2.0.0.sql
npm run supabase:restart:with:diff:manualrelease --bumptype=major

# no arg — defaults to minor
npm run supabase:restart:with:diff:manualrelease
```

**First run** (no existing `fsm_core--<version>.sql` in migrations): creates `fsm_core--<version>.sql` with no version bump.

**Subsequent runs**: bumps `package.json` version and creates `fsm_core--<old>--<new>.sql` as an upgrade script.

The bump type is passed via `process.env.npm_config_bumptype` which npm propagates automatically across the script chain.

## Migration notes

Migrations live in `supabase/migrations/` and are applied in timestamp order. Schema source files live in `supabase/schemas/` — they are the source of truth that `supabase db diff` compares against to generate new migrations.

### Pre-migration scripts

These must run before any FSM schema is applied. They set up the required extensions and the `fsm_core` schema itself. Supabase applies them automatically in timestamp order.

| Migration file | Schema file | What it does | Notes |
|---|---|---|---|
| `20241218134623_pre_migrations_fsm_core_extension_prerequisites.sql` | `20241218134623_supabase_only_pre_migrations_fsm_core_extension_prerequisites.sql` | Installs `ltree` and `pgmq` extensions | The schema version wraps `pgmq` in a `DO` block to tolerate Supabase environments where pgmq is pre-installed. The migration version uses bare `CREATE EXTENSION IF NOT EXISTS`. |
| `20241218134632_pre_migrations_fsm_core_extension_init.sql` | `20241218134632_pre_migrations_fsm_core_extension_init.sql` | Creates `fsm_core` schema, installs `pg_jsonschema` (pinned `0.3.3`) into it, adds a `hello()` smoke-test function | `hello()` is a no-op used only to verify the extension loaded. Shared between migration and schema — same file name, identical content. |

### Supabase-only schema files

These files exist only in `supabase/schemas/` and are **never** emitted as standalone migrations. They contain setup specific to running inside Supabase (roles, grants, wrappers) that would be a no-op or break on plain PostgreSQL.

| Schema file | What it does | Notes |
|---|---|---|
| `20241218134622_PGMQ_source.sql` | Full pgmq extension DDL | Reference copy only — not applied directly. pgmq is installed via `CREATE EXTENSION`. |
| `20241218134624_supabase_only_pgmq_to_public_schema.sql` | Public-schema `SECURITY DEFINER` wrappers for pgmq functions (`create`, `send`, `read`, `archive`, etc.) | Entirely commented out. Kept as reference if public-schema exposure is needed. |
| `20241218134634_supabase_only_pgmq_to_fsm_core_schema.sql` | `fsm_core`-schema wrappers for the same pgmq functions | Entirely commented out. `fsm_core` calls pgmq directly — wrappers were not needed. |
| `20250319134653_fsm_core_supabase_access_update.sql` | Grants `USAGE` + `ALL` on tables/routines/sequences in `fsm_core` to `anon`, `authenticated`, and `service_role` | Required for Supabase RLS and PostgREST to expose `fsm_core` to API consumers. No effect outside Supabase. |

### Versioned release migrations

Generated by the [manual release](#manual-release) workflow. Follow the PostgreSQL extension upgrade naming convention so the history of schema versions is self-documenting.

| Pattern | Example | Meaning |
|---|---|---|
| `{ts}_fsm_core--{version}.sql` | `20260602112452_fsm_core--1.0.0.sql` | Initial release snapshot for that version |
| `{ts}_fsm_core--{old}--{new}.sql` | `20260602120208_fsm_core--1.0.0--1.1.0.sql` | Upgrade diff from `old` → `new` |

## Reference docs

- [PG→TS function mapping](./docs/pg-ts-function-mapping.md) — authoritative table of all PostgreSQL functions and their TypeScript wrappers
- [PostgreSQL v1 functions](./docs/pg-v1-functions.md) — superseded v1 functions (no TS wrappers)
- [v1 argument rename suggestions](./docs/pg-v1-argument-rename-suggestions.md) — suggested `p_*` → `input_*` renames for v1 functions

## Node version

Managed by `.prototools`. Install with:

```bash
proto install node 22 --pin local
```
