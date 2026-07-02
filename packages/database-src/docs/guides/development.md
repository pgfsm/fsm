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
