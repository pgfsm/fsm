# Development Setup

## Runtime requirements

Node version is pinned via [proto](https://moonrepo.dev/docs/proto/overview).
Check `.prototools` at the repo root for the exact version. To install:

```bash
proto install node 22 --pin local
```

Dependencies are managed with npm:

```bash
npm install
```

## Local Supabase

```bash
# Start local Supabase (reads credentials from .env)
npm run supabase:start:env

# Stop local Supabase
npm run supabase:stop

# Reset DB and re-run all migrations from scratch
npm run supabase:db:reset

# Apply pending migrations without a full reset
npm run supabase:db:migrate

# Generate TypeScript types from the live schema — run after any PG change
npm run supabase:gen:types
```

### Test data

```bash
# Seed three fake users into Supabase Auth
npm run supabase:db:addfakeusers

# Remove those fake users
npm run supabase:db:deletefakeusers
```

## Testing (pgTAP)

Tests live in `supabase/tests/` — the directory name the Supabase CLI's pgTAP
runner hardcodes (`supabase test db` mounts `supabase/tests` directly; it can't
be pointed at an arbitrarily named folder). One file per file in
`supabase/schemas/`, sharing the same basename (e.g.
`schemas/20241218134636_fsm_advisory_lock_helper.sql` →
`tests/20241218134636_fsm_advisory_lock_helper.sql`). `tests/000_setup.sql`
bootstraps the `pgtap` extension and always runs first (pg_prove executes files
in alphabetical order).

```bash
# Local Supabase must already be running (npm run supabase:start:env)
npm run supabase:test:db
```

Each test file wraps its assertions in `begin; ... rollback;` so behavioral
tests never leave data behind in the shared local dev database. Two tiers,
applied depending on what the schema file defines:

- **Structural** (`has_table`, `has_column`, `col_type_is`, `has_function`,
  `has_trigger`, `has_type`) — for every schema file, proving the objects it
  creates exist with the right shape.
- **Behavioral** (`results_eq`, `throws_ok`, `lives_ok`) — for files with real
  logic, exercising representative inputs/outputs.

The 5 fully-commented-out reference/changelog files in `supabase/schemas/` (no
live objects) intentionally have no matching test file.

## Making schema changes (day-to-day)

Schema source files live in `supabase/schemas/` — they are the source of truth.
Migrations in `supabase/migrations/` are generated output; never hand-edit them
to add schema logic.

1. Edit the relevant file in `supabase/schemas/`
2. Run the temp diff command — it auto-bumps the patch version in
   `package.json`, generates the migration, restarts Supabase, and regenerates
   types in one step:
   ```bash
   npm run supabase:restart:with:diff:withUpgradeScript:temp
   ```

> Use this for iterative dev work. For a deliberate release bump (minor/major),
> see [release.md](./release.md).
