# Release Workflow

## Creating a versioned release migration

The filename is computed by `get-next-pkg-version.ts`, which compares the
current `package.json` version against the highest version already recorded in
`supabase/migrations/`.

### Check current state

```bash
# Print the highest version found in supabase/migrations/
npm run getExistingHighestVersion

# Print the filename that would be generated next (dry-run, no files written)
npm run getNextVersion
```

`getNextVersion` exits non-zero with a clear error if:

- `package.json` version already matches the highest migration version (no-op —
  update the version first)
- `package.json` version is lower than the highest migration version (version
  went backwards)

### Run the release

Update `package.json` to the intended new version, then:

```bash
# Generate migration diff, restart Supabase, regenerate types
npm run supabase:restart:with:diff:withUpgradeScript
```

**First run** (no existing `fsm_core--<version>.sql` in migrations): creates
`fsm_core--<version>.sql`.

**Subsequent runs**: creates `fsm_core--<old>--<new>.sql` as an upgrade diff
where `<old>` is the current highest migration version and `<new>` is the
`package.json` version.

For a quick patch bump without manually editing `package.json`:

```bash
npm run supabase:restart:with:diff:withUpgradeScript:temp
```

## Releasing fsm_core (SPEC-016)

1. Generate the version locally:
   `npm run generateBothPgextAndFullsqlscript -- patch` (or minor / major).
2. Fix up the new upgrade script by hand (roles and grants; the
   `SELECT fsm_core.require_version('<from>');` first line is added for you; see
   [CLAUDE.md](../../CLAUDE.md#install-artifacts-and-versions-spec-016)).
3. Commit the migration and the generated `all-output/fsm_core--<v>.sql` and
   `all-output-with-prerequisite-check/fsm_core--<v>.sql`; merge.
4. Push an `fsm_core-v<version>` tag from main once its CI has passed.

`.github/workflows/fsm-core-release.yml` then runs, each job only if the one
before it passed:

1. **preflight**: the tag is `fsm_core-v<x.y.z>`; older versions can be released
   too (their GitHub release isn't marked "Latest");
2. **build**: `build-both-pgext-and-fullsqlscript.ts --version <v>`;
3. **compare**: `compare-pgext-and-fullsqlscript.ts <v>` on PostgreSQL 15, 16,
   17 and 18;
4. **pgxn**: uploads the zip when `PGXN_USERNAME` and `PGXN_PASSWORD` are set
   (an upload error stops the release; a version PGXN already has counts as
   done), and skips the upload when they aren't;
5. **github-release**: the full script (`fsm_core--<v>.sql`, the plain-SQL
   install), the zip (which also holds every upgrade script) and `SHA256SUMS`.

## Building the PGXN package

```bash
npm run generateBothPgextAndFullsqlscript -- patch          # create the new version (or minor / major)
npm run buildBothPgextAndFullsqlscript -- --version 2.3.2   # build it
```

Generating runs `supabase-restart-with-diff.ts <bump>` (the upgrade script; it
restarts the local Supabase) and
`supabase-dump-for-full-version.ts --version
<v>` (the full script,
`all-output/fsm_core--<v>.sql`). Review the new upgrade script, then build: from
the full script in `all-output/` and an unbroken upgrade chain in
`supabase/migrations/`, it clears `pgxn-dist/`, stages those files (timestamp
prefix stripped), the filled `pgxn-templates/` and the README there, and writes
`fsm_core-<version>.zip`; it stops if a file is missing. It doesn't upload:
`fsm-core-release.yml` does, from an `fsm_core-v<version>` tag.

## Migration naming

Migrations follow the PostgreSQL extension upgrade naming convention.

### Pre-migration scripts

Must run before any FSM schema is applied. Applied automatically by Supabase in
timestamp order. Not part of the full install or the PGXN bundle: the plain-SQL
install replaces them with a prerequisites block (PostgreSQL 15+, ltree,
pg_cron, pgmq), and the PGXN control file `requires` the extensions.

| Migration file                                                       | What it does                                                                                    | Notes                                                           |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `20241218134623_pre_migrations_fsm_core_extension_prerequisites.sql` | Installs `ltree` and `pgmq` extensions                                                          | Supabase only; the full install has its own prerequisites block |
| `20241218134632_pre_migrations_fsm_core_extension_init.sql`          | Creates `fsm_core` schema, installs `pg_jsonschema` (pinned `0.3.3`), adds `hello()` smoke-test | `hello()` is a no-op to verify the extension loaded             |

### Supabase-only schema files

Exist only in `supabase/schemas/` — never emitted as standalone migrations.
Contain setup specific to Supabase (roles, grants, wrappers) that would be a
no-op or break on plain PostgreSQL.

| Schema file                                                | What it does                                                                                   | Notes                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `20241218134622_PGMQ_source.sql`                           | Full pgmq extension DDL                                                                        | Reference copy only — not applied directly                          |
| `20241218134624_supabase_only_pgmq_to_public_schema.sql`   | Public-schema `SECURITY DEFINER` wrappers for pgmq functions                                   | Entirely commented out — kept as reference                          |
| `20241218134634_supabase_only_pgmq_to_fsm_core_schema.sql` | `fsm_core`-schema wrappers for the same pgmq functions                                         | Entirely commented out — `fsm_core` calls pgmq directly             |
| `20250319134653_fsm_core_supabase_access_update.sql`       | Grants `USAGE` + `ALL` on tables/routines/sequences to `anon`, `authenticated`, `service_role` | Required for Supabase RLS and PostgREST; no effect outside Supabase |

### Versioned release migrations

| Pattern                           | Example                                     | Meaning                         |
| --------------------------------- | ------------------------------------------- | ------------------------------- |
| `{ts}_fsm_core--{version}.sql`    | `20260602112452_fsm_core--1.0.0.sql`        | Initial release snapshot        |
| `{ts}_fsm_core--{old}--{new}.sql` | `20260607154229_fsm_core--1.0.0--1.1.0.sql` | Upgrade diff from `old` → `new` |
