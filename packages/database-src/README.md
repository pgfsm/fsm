# database-src — PostgreSQL Schema & Migrations

The PostgreSQL source of truth for the FSM framework. Contains schema files, migrations, Supabase configuration, and the generated TypeScript types consumed by `fsm-core-db-ts`.

## What it produces

- **Migrations** — timestamped SQL files in `supabase/migrations/` that bring the database to the current state
- **Generated types** — `database.types.ts` auto-generated from the live schema, consumed by `@fsm/db`

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

## Migration notes

- `20250602124504_pgmq.sql` is manually added and must run before all other migrations — it patches pgmq setup required by subsequent scripts
- Force migration files (not named `declarative_update`) are manually sequenced patches; they do not follow the standard diff flow

## Node version

Managed by `.prototools`. Install with:

```bash
proto install node 22 --pin local
```
