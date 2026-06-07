# Release Workflow

## Creating a versioned release migration

The filename is computed by `get-next-pkg-version.ts`, which compares the current `package.json` version against the highest version already recorded in `supabase/migrations/`.

### Check current state

```bash
# Print the highest version found in supabase/migrations/
npm run getExistingHighestVersion

# Print the filename that would be generated next (dry-run, no files written)
npm run getNextVersion
```

`getNextVersion` exits non-zero with a clear error if:
- `package.json` version already matches the highest migration version (no-op — update the version first)
- `package.json` version is lower than the highest migration version (version went backwards)

### Run the release

Update `package.json` to the intended new version, then:

```bash
# Generate migration diff, restart Supabase, regenerate types
npm run supabase:restart:with:diff:withUpgradeScript
```

**First run** (no existing `fsm_core--<version>.sql` in migrations): creates `fsm_core--<version>.sql`.

**Subsequent runs**: creates `fsm_core--<old>--<new>.sql` as an upgrade diff where `<old>` is the current highest migration version and `<new>` is the `package.json` version.

For a quick patch bump without manually editing `package.json`:

```bash
npm run supabase:restart:with:diff:withUpgradeScript:temp
```

## Building the PGXN package

```bash
npm run pgxnBuildAndPublish
```

This fills `pgxn-templates/` with values from `package.json`, stages migration files (timestamp prefix stripped) and `README.md` into `pgxn-dist/`, and produces `fsm_core-<version>.zip` ready for PGXN upload.

The `package.json` version must match the highest version in `supabase/migrations/` — the script will error otherwise.

## Migration naming

Migrations follow the PostgreSQL extension upgrade naming convention.

### Pre-migration scripts

Must run before any FSM schema is applied. Applied automatically by Supabase in timestamp order.

| Migration file | What it does | Notes |
|---|---|---|
| `20241218134623_pre_migrations_fsm_core_extension_prerequisites.sql` | Installs `ltree` and `pgmq` extensions | Uses bare `CREATE EXTENSION IF NOT EXISTS` |
| `20241218134632_pre_migrations_fsm_core_extension_init.sql` | Creates `fsm_core` schema, installs `pg_jsonschema` (pinned `0.3.3`), adds `hello()` smoke-test | `hello()` is a no-op to verify the extension loaded |

### Supabase-only schema files

Exist only in `supabase/schemas/` — never emitted as standalone migrations. Contain setup specific to Supabase (roles, grants, wrappers) that would be a no-op or break on plain PostgreSQL.

| Schema file | What it does | Notes |
|---|---|---|
| `20241218134622_PGMQ_source.sql` | Full pgmq extension DDL | Reference copy only — not applied directly |
| `20241218134624_supabase_only_pgmq_to_public_schema.sql` | Public-schema `SECURITY DEFINER` wrappers for pgmq functions | Entirely commented out — kept as reference |
| `20241218134634_supabase_only_pgmq_to_fsm_core_schema.sql` | `fsm_core`-schema wrappers for the same pgmq functions | Entirely commented out — `fsm_core` calls pgmq directly |
| `20250319134653_fsm_core_supabase_access_update.sql` | Grants `USAGE` + `ALL` on tables/routines/sequences to `anon`, `authenticated`, `service_role` | Required for Supabase RLS and PostgREST; no effect outside Supabase |

### Versioned release migrations

| Pattern | Example | Meaning |
|---|---|---|
| `{ts}_fsm_core--{version}.sql` | `20260602112452_fsm_core--1.0.0.sql` | Initial release snapshot |
| `{ts}_fsm_core--{old}--{new}.sql` | `20260607154229_fsm_core--1.0.0--1.1.0.sql` | Upgrade diff from `old` → `new` |
