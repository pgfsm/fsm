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

- `20250602124504_pgmq.sql` is manually added and must run before all other migrations — it patches pgmq setup required by subsequent scripts
- Force migration files (not named `declarative_update`) are manually sequenced patches; they do not follow the standard diff flow

## Reference docs

- [PG→TS function mapping](./docs/pg-ts-function-mapping.md) — authoritative table of all PostgreSQL functions and their TypeScript wrappers
- [PostgreSQL v1 functions](./docs/pg-v1-functions.md) — superseded v1 functions (no TS wrappers)
- [v1 argument rename suggestions](./docs/pg-v1-argument-rename-suggestions.md) — suggested `p_*` → `input_*` renames for v1 functions

## Node version

Managed by `.prototools`. Install with:

```bash
proto install node 22 --pin local
```
