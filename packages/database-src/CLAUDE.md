# CLAUDE.md — Database (`packages/database-src/`)

Scoped guidance for PostgreSQL migrations + Supabase config. Repo-wide
conventions and session protocol live in the root `CLAUDE.md` / `AGENTS.md`.

## Commands

```bash
npm run supabase:start              # start local Supabase
npm run supabase:db:reset           # reset and re-run all migrations
npm run supabase:gen:types          # regenerate TypeScript types

# restart, diff schema, and regenerate types — pick the version bump:
npm run supabase:restart:with:diff:withUpgradeScript:patch
npm run supabase:restart:with:diff:withUpgradeScript:minor
npm run supabase:restart:with:diff:withUpgradeScript:major

# regenerate fsm-compiler-ts's FsmMachineJson type from fsm.machine.schema.v3.json
npm run generate:fsm-types          # (or: deno task generate:fsm-types)

# regenerate the Postgres ENUM types derived from fsm.machine.schema.v3.json
npm run generate:pg-types           # (or: deno task generate:pg-types)
```

A new fsm_core version starts with the Deno flow, which writes the upgrade
script and also sets `fsm_core.version()` (in
`schemas/10_ext_helper/…_fsm_core_version.sql`) to the new version before
diffing:

```bash
deno run --allow-all supabase-restart-with-diff.ts patch   # or minor / major
deno run --allow-all supabase-restart-with-diff.ts patch --enable_all_supabase_service
```

By default it restarts **only Postgres** (`supabase start -x …`, the same list
CI uses): the diff, `db dump --local` and `gen types --local` need nothing else,
and it starts faster with far less memory. `--enable_all_supabase_service` (or
`=true`) starts every service (Studio, auth, the REST API, …).
`generate-both-pgext-and-fullsqlscript.ts` takes the same flag and passes it on.

It takes the version from `supabase/migrations/` (highest + bump) and writes
`fsm_core--<from>--<to>.sql` there. The upgrade script still needs its
hand-written parts (`require_version`, roles, grants; see Access control). The
full scripts come from `supabase-dump-for-full-version.ts`, not the diff.

`supabase-dump-for-full-version.ts [patch|minor|major] [--db-url <url>]` (or
`--version <x.y.z>`) writes `all-output/fsm_core--<v>.sql` from two dumps of the
local Supabase (or `--db-url`; never `--remote`): `--role-only` and
`--schema fsm_core --keep-comments`. It keeps only `fsm_*` roles, each created
only if missing and without `BYPASSRLS`, their memberships without `GRANTED BY`,
and the installing login made a member of the `fsm_*` roles the dumped
database's owner has. It drops `OWNER TO`, `CREATE EXTENSION`,
`CREATE SCHEMA fsm_core` and grants to other roles, and appends the pgmq grants
(from the access-control file), the pg_cron registration and a version check.
Next to it, it writes `all-output-with-prerequisite-check/fsm_core--<v>.sql`:
the prerequisites block (`scripts/prerequisites-sql.ts`, shared with the full
install) followed by the full script, a plain-SQL install (`psql -1 -f`). Both
give the same fsm_core as the migration chain. The CLI's pg_dump is 15.x, so it
can only dump Postgres 15.

> There's no bare `supabase:restart:with:diff` script — always specify `patch` /
> `minor` / `major` (see `package.json` for the full script list, including
> `buildBothPgextAndFullsqlscript` for the pgxn extension release flow).

All `supabase:*` scripts accept a `SUPABASE_WORKDIR` env var (default `.`) that
they forward to the Supabase CLI's `--workdir` flag.

## Access control (`schemas/40_access_control/`, SPEC-009 §1–2)

Roles `fsm_operator`, `fsm_admin`, `fsm_worker`, `fsm_authenticator`; the
entry-point functions TypeScript calls are `SECURITY DEFINER` with a pinned
`search_path`, and roles get `EXECUTE` on them (plus narrow table grants where
`@pgfsm/db` touches a table directly). The folder is last in `schema_paths`, so
its `ALTER FUNCTION`s run after every function is defined.

**`supabase db diff` only half-captures it.** It emits table grants and the
functions' `SECURITY DEFINER`/`search_path`, but drops `CREATE ROLE`, role
memberships, function `EXECUTE` grants/revokes, schema `USAGE` and the pgmq
grants (the same class of gap that kept the pg_cron job out of migrations,
#468). So after a diff that touches this area, copy those blocks from
`20261005120100_fsm_core_access_control.sql` into the new migration by hand: the
roles block at the **top** (the diffed table grants need the roles), the rest at
the end.

**Adding a function that TypeScript calls:** add it to the right
`ALTER FUNCTION … SECURITY DEFINER` and `GRANT EXECUTE` lists in that file, and
copy the `REVOKE`/`GRANT` into your migration. `tests/40_access_control/` fails
CI on any `fsm_core` function executable by `PUBLIC`, and on any
`SECURITY DEFINER` function not granted to an `fsm_*` role.

Gotcha: on Supabase (PG 15.8) `GRANT <role> TO CURRENT_USER` segfaults the
backend. Grant to the role by name (`format('… TO %I', current_user)` in a `DO`
block).

## Install artifacts and versions (SPEC-016)

fsm_core ships as SQL, generated per version (see "PGXN release build" below): a
plain-SQL install (`all-output-with-prerequisite-check/fsm_core--<v>.sql`, a
prerequisites block then the full script) and the PGXN extension zip (the full
script `all-output/fsm_core--<v>.sql` plus every upgrade script).
`deno task compare:pgext <v> [--pg 16]` (`compare-pgext-and-fullsqlscript.ts`)
checks in Docker (`install-test/`: stock Postgres + pg_cron + pgmq) that the
plain-SQL install, run as a non-superuser that owns the database, and
`CREATE EXTENSION` give the same fsm_core
(`scripts/compare-fsm-core-catalog.ts`). It reads
`full-release/full-release-<v>/` and stops, saying how to create it, when it's
missing. `fsm-core-release.yml` releases from an `fsm_core-v<version>` tag (see
`docs/guides/release.md`): tag check, build, compare on PostgreSQL 15 to 18,
PGXN upload (when its secrets are set), then the GitHub release.

The chain starts at the 1.2.0 baseline, `fsm_core--1.2.0.sql` (#697): the
unreleased 1.0.0 → 2.3.1 chain squashed into a copy of
`all-output/fsm_core--1.2.0.sql`. A local database still at 2.x has no upgrade
path to it: `npm run supabase:db:reset`.

**Every new version's migration must:**

- start with `SELECT fsm_core.require_version('<from>');` (the diff doesn't
  generate it; `supabase-restart-with-diff.ts` adds it after diffing);
- redefine `fsm_core.version()` to return the new version: the same script bumps
  the literal in `schemas/10_ext_helper/20261103120000_fsm_core_version.sql`
  before diffing, and the diff carries it.

`scripts/check-fsm-core-version.ts` checks both (`deno task check:version`). Its
prek hook is disabled for now and CI doesn't run it (a TODO in `prek.toml`). The
API, fsmlet and gateway refuse to start on an fsm_core below
`FSM_CORE_MIN_VERSION` (`@pgfsm/db`), or of a later major version.

Things the install relies on:

- **pgmq** is a required extension, like pg_cron: the install creates it if the
  server has it and refuses otherwise. Supabase and Neon have it; PGDG doesn't
  package it, so `install-test/Dockerfile` copies its SQL-only extension files
  from pgmq's source release (1.4.4, the version Supabase runs). pgfsm doesn't
  ship pgmq's code. `schemas/00_pre_ext/20241218134622_PGMQ_source.sql` is only
  an old commented-out reference copy.
- **pg_cron** is required: the 1.2.0 baseline migration registers the
  `fsm_schedule_all_pending` job through `register_scheduler_job_v2()`, so
  `supabase db reset` leaves it registered too. pg_cron can only be created in
  the `cron.database_name` database.
- **pg_jsonschema** is optional: `load_fsm_from_json_v2` calls it only where
  it's installed (Supabase's pre-migration installs it; the full install
  doesn't). The pgTAP tests need it.
- In the PGXN form every fsm_core function is a member of the `fsm_core`
  extension, so a check that skips "extension members" must skip only _other_
  extensions' members (the PUBLIC-revoke loop in `40_access_control` once did
  not).

## Clock seams (`schemas/10_ext_helper/…_fsm_core_clock.sql`, SPEC-015 §2)

Never call `now()` / `clock_timestamp()` (or `current_timestamp` and friends) in
`fsm_core` SQL, including the SQL `@pgfsm/db` sends inline. Use
`fsm_core.tx_now()` (for `now()`) and `fsm_core.wall_now()` (for
`clock_timestamp()`), so the deterministic simulator can run the real SQL on
virtual time. They return the `fsm_core.sim_now` GUC only for a login in the
NOLOGIN role `fsm_sim`, which nothing in production is granted.
`scripts/check-sql-clock-seams.ts` (prek + CI) enforces it. The vendored pgmq
source is exempt and stays pristine; the sim database build rewrites it.

## The local Supabase project

`supabase/` backs the API and everything else in this repo. (The second,
`full-ext/` project for the pgrx extension was removed.)

## PGXN release build (`build-both-pgext-and-fullsqlscript.ts`)

```bash
npm run generateBothPgextAndFullsqlscript -- patch   # 1. create the version (or minor / major)
npm run buildBothPgextAndFullsqlscript -- --version 1.2.1   # 2. build it
deno run --allow-all compare-pgext-and-fullsqlscript.ts 1.2.1 [--pg 16] [--keep]   # 3. compare
```

**Comparing** (`compare-pgext-and-fullsqlscript.ts <v>`) checks the two forms in
`full-release/full-release-<v>/` install the same fsm_core. It stops (pointing
at the build) if the folder, the zip or the full script is missing. In Docker
(`install-test/`, `--pg` default 16) it runs the full script as a non-superuser
database owner in one container and `CREATE EXTENSION fsm_core CASCADE` from the
zip in another, checks both are at `<v>`, and compares their catalogs
(`scripts/compare-fsm-core-catalog.ts`); any difference exits 1.

**Generating** (`generate-both-pgext-and-fullsqlscript.ts`) computes the new
version once (highest in `supabase/migrations/` + bump), runs
`supabase-restart-with-diff.ts <bump>` (the upgrade script; restarts the local
Supabase with every migration applied) and then
`supabase-dump-for-full-version.ts --version <v>`
(`all-output/fsm_core--<v>.sql` and its plain-SQL install in
`all-output-with-prerequisite-check/`). Review the upgrade script before
building.

**Building** (`build-both-pgext-and-fullsqlscript.ts --version <v>`) is a pure
build step: it never creates a version or touches Supabase. CI's install test
and the release use it the same way.

It builds the bundle in the standard extension layout: the **full script**
`all-output/fsm_core--<v>.sql` (for `CREATE EXTENSION`) and **every upgrade
script** up to `<v>` from `supabase/migrations/` (for
`ALTER EXTENSION … UPDATE`), timestamps stripped, plus the control file,
`META.json` (from `pgxn-templates/`) and `README.md`. It stops if the full
script is missing or the upgrade chain has a gap.

**Full scripts live in `all-output/`**, one per version, written by the dump
script (with the plain-SQL install next to it); commit both. The release builds
from these committed files.

`pgxn-dist/` (gitignored) is cleared at the start and kept afterwards, for
inspection. Nothing is uploaded: `fsm-core-release.yml` publishes the zip to
PGXN. Because the bundle has only the newest full script, an extension can't be
created at an older version from it. Nothing tests the upgrade path
automatically for now.

`generate:fsm-types` (`scripts/generate-fsm-json-types.ts`) reads
`fsm.machine.schema.v3.json` and writes `generated/fsm-machine-schema.types.ts`
— `fsm-compiler-ts` imports it from there via a cross-package relative path (see
its `CLAUDE.md`). Run it after any change to the schema's
`asyncOperationType`/invoke shape. The npm script just delegates to the deno
task (`deno task generate:fsm-types`); both work identically since `deno` is
proto-pinned at the repo root and resolves here via upward file resolution.

`generated/database.types.ts` (Supabase-generated, via `supabase:gen:types` /
`supabase:restart:with:diff:...`) lives in the same directory —
`packages/fsm-core-db-ts/src/database.types.ts` imports the `Database`/`Json`
types from it via a relative path and re-exports them as
`@pgfsm/db/database.types` for every other package.

`generate:pg-types` (`scripts/generate-fsm-json-postgres-types.ts`) reads the
same schema and writes two generated files:

- `supabase/schemas/10_ext_helper/fsm_core_enums.generated.sql` —
  `CREATE TYPE ... AS ENUM (...)` statements, one per enum-valued schema field,
  **except** two deliberately skipped (documented in the script itself): the
  state-node `type` enum, which already exists as `fsm_core.fsm_state_type`
  (`supabase/schemas/11_ext_base/20241219134646_fsm_table.sql`), and
  `actionObject`'s `if`/`then` conditional enum, which isn't a real field
  constraint. The enum-to-type-name mapping is a small hand-picked list in the
  script, not derived automatically — good Postgres type names don't fall out of
  JSON-schema paths mechanically. These generated types aren't wired into any
  existing function signature yet (those still take `text`); that's a separate,
  larger follow-up.
- `supabase/schemas/10_ext_helper/fsm_core_json_schema.generated.sql` —
  `fsm_core.fsm_json_schema()`, a SQL function returning the entire schema as
  JSON, with the file's contents embedded as the literal (re-serialized via
  `JSON.parse`/`JSON.stringify`, not the raw file bytes). Replaces a hand-copied
  version that used to live directly in
  `10_ext_helper/20241218134635_fsm_module_config.sql` and had drifted out of
  sync with the real schema.

PostgreSQL is the source of truth for the schema — see
`packages/fsm-core-db-ts/CLAUDE.md` for the naming rules TypeScript wrappers
must follow, and `docs/reference/pg-ts-function-mapping.md` for the full PG→TS
mapping table.
