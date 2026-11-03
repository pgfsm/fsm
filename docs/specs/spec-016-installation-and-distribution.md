# SPEC-016: Installation and Distribution

| Field      | Value                                                                                                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | Draft                                                                                                                                                                                                                              |
| Date       | 2026-11-03                                                                                                                                                                                                                         |
| Authors    | Niraj, Claude (Opus 5.5)                                                                                                                                                                                                           |
| Issue      | #686                                                                                                                                                                                                                               |
| Affects    | `packages/database-src` (install and upgrade SQL, release workflow), `apps/fsm-core-ts-hono-deno` → `packages/fsm-api-ts` (`@pgfsm/api`), `packages/fsm-ctl-ts` (`pgfsmctl`), `packages/fsm-cli-ts` (generated compose file), docs |
| Supersedes | SPEC-009 §4–5 in part (`pgfsmctl`'s two tiers), SPEC-003's fallback scheduler process                                                                                                                                              |

Related: SPEC-003 (pg_cron scheduler), SPEC-006 (definitions as a deploy step),
SPEC-007 (gateway image, manifests and release), SPEC-009 (access model, API
keys, `pgfsmctl`), SPEC-015 (clock seams), ADR-003 (connection minimization,
Kubernetes deploy target).

---

## Problem

**Nobody outside this repository can install pgfsm end to end.**

- **The database layer has no artifact.** No README, guide or generated project
  says how to get `fsm_core` into a user's Postgres. A generated project's "Run
  the stack" starts at `npm run db:load`, which assumes `fsm_core` is already
  there. The only working path is to clone the repo and run `supabase start` /
  `db reset` in `packages/database-src`: a full Supabase stack. There are no
  `fsm_core` tags and no release assets, and nothing has been published to PGXN
  although `pgxn-build-and-publish.ts` exists.
- **The REST API has no artifact either.** `apps/fsm-core-ts-hono-deno` has no
  name or version in `deno.json`, no Dockerfile, no manifests and no release
  workflow. Yet `pgfsmctl`'s API tier and the generated `.env.example` point
  users at it.
- **Everything else is published:** the compiler, the sync worker, the gateway,
  the SDKs (npm, PyPI, crates.io, Go), and soon `@pgfsm/ctl` and `@pgfsm/cli`. A
  user can generate a project and start workers, then has no database to point
  them at.

**Why now:** `@pgfsm/ctl` 0.1.0 (#454) and `@pgfsm/cli` 0.1.0 (#383) are about
to be published. Publishing them invites people in, and they'd hit this wall at
once.

**Priority:** production portability first (a team on its own Postgres: RDS,
Cloud SQL, Azure, Neon, Supabase, self-hosted), with the local developer stack
built directly on the same install.

## Constraints

1. **Connection minimization; Kubernetes as the deploy target** (ADR-003,
   amended in #680). The API ships like the gateway; no new connection-heavy
   components.
2. **Function-boundary access; the API never holds schema-owner rights**
   (SPEC-009). Roles `fsm_operator`, `fsm_admin`, `fsm_worker`,
   `fsm_authenticator`, `fsm_sim`; access through `SECURITY DEFINER` functions.
3. **Definitions are a deploy step and immutable per version** (SPEC-006).
4. **pg_cron registration is data, not schema** (SPEC-003): `supabase db diff`
   can't capture it, so it's hand-written.
5. **SQL and PL/pgSQL only.** The pgrx extension was explored and not adopted
   (`database-src-extension` README), partly because managed providers allow SQL
   but block native code.
6. **Migrations come from `supabase db diff` over `schemas/`,** named
   `fsm_core--a--b.sql`, with roles and grants added by hand
   (`database-src/CLAUDE.md`).
7. **Supabase-specific pieces exist:** `supabase_only_*` files in `00_pre_ext/`
   and `05_ext_module_init/`; pgmq is created as an extension where available,
   otherwise installed from the vendored SQL source.
8. **Supported Postgres: 15 and later** (15, 16, 17), tested in CI on each.
   Decided in this design; the repo has only run 15 so far.
9. **The installer is the provider's admin login, never a true superuser:**
   `rds_superuser`, `cloudsqlsuperuser`, Supabase's `postgres`, or a self-hosted
   login with `CREATEROLE`. Installing needs `CREATE ROLE` (the roles are
   cluster-wide), `CREATE EXTENSION ltree` (trusted since PG 13) and pg_cron.

**What pgfsm needs from Postgres:**

| Dependency    | Use                                                                                                                                   | Managed availability                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| pgmq          | **Vendored as SQL** (`00_pre_ext/…_PGMQ_source.sql`)                                                                                  | No extension needed                                               |
| ltree         | State paths in the macrostep functions                                                                                                | Standard contrib: everywhere                                      |
| pg_cron       | The scheduler (SPEC-003)                                                                                                              | RDS, Cloud SQL, Azure, Supabase, Neon; `shared_preload_libraries` |
| pg_jsonschema | Created at install, but **used only by pgTAP tests**; no runtime function calls it (definitions are validated with AJV in TypeScript) | Supabase-specific; most providers don't have it                   |

## Options considered

### 1. How the database is delivered

| Option                                                               | Pros                                                                       | Cons                                                                                                                  |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Own Postgres image** (like `supabase/postgres`)                    | Instant local start                                                        | Managed providers don't take custom images; patching Postgres majors × architectures; "run our Postgres" is a big ask |
| **Native extension** (pgrx/C)                                        | `CREATE EXTENSION`; fast                                                   | Blocked on RDS, Cloud SQL, Azure; builds per OS × arch × PG; already decided against                                  |
| **A1. SQL scripts** (full install + upgrade chain) as release assets | Works on any Postgres; fits teams' own migration tools; little to maintain | No runner: users pick the pending scripts themselves (mitigated by version guards, below)                             |
| **A2. The same SQL packaged as an extension** (PGXN; pg_tle later)   | `CREATE EXTENSION` / `ALTER EXTENSION … UPDATE` where allowed              | Self-hosted, or pg_tle providers (RDS, Supabase) only                                                                 |
| **B. A runner** (`pgfsmctl db migrate`, SQL bundled in `@pgfsm/db`)  | One command; computes pending scripts                                      | Another runner to maintain; owner login in tooling; coexisting with Supabase's own tracking                           |
| **C. API migrate mode** (the GoTrue/Storage pattern)                 | The database upgrades with the API release                                 | An owner login in the API image (kept apart from its runtime login); does nothing without the API                     |

### 2. Where `pgfsmctl` gets its access

| Option                                                                                    | Pros                                                 | Cons                                                                  |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| **Two tiers** (SPEC-009 today): DB-direct bootstrap + API for operations                  | Bootstrap without the API                            | Two code paths; database credentials in profiles; the tier pin (#663) |
| **Pure API** (kubectl-style), with bootstrap moved into the install SQL and a key command | One transport; no database URLs on operator machines | Nothing works without a running API; break-glass is `psql`            |

SPEC-009 rejected pure-API (its Option C) because bootstrap would depend on the
API and the API would need DDL rights. With A1/A2, **migrations and pg_cron
registration are part of installing the SQL**, and the first admin key comes
from a one-off command, so neither reason holds.

### 3. Without pg_cron

| Option                                 | Cons                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------- |
| **Required** (fail clearly at install) | Self-hosted users must preload it                                           |
| `scheduler run` fallback (today)       | A second scheduler to keep alive and test                                   |
| The API runs the fallback loop         | Bends root `CLAUDE.md` point 3 (the HTTP tier doesn't own worker lifecycle) |
| Library only (`runFsmScheduler`)       | Unsupported in practice                                                     |

### 4. Packaging the API

| Option                                                                  | Cons                                               |
| ----------------------------------------------------------------------- | -------------------------------------------------- |
| **Mirror the gateway:** npm + GHCR image + manifests + release workflow | The most to set up (largely copy and adapt)        |
| Image only                                                              | No `npx` local runs; inconsistent with the gateway |
| npm only                                                                | Every production user builds their own image       |

### 5. The first admin key

How Supabase does it: self-hosted derives `ANON_KEY` / `SERVICE_ROLE_KEY` JWTs
from a `JWT_SECRET` in `.env` (stateless; rotation invalidates every key);
hosted creates keys at project creation (opaque, revocable `sb_secret_…` in the
2025 model); local `supabase start` prints its keys. pgfsm's keys are already
opaque, hashed and revocable.

| Option                                                            | Cons                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **One-off command** `pgfsm-api key bootstrap` printing a key once | A manual step; awkward for GitOps                                                                |
| Hashed key in an environment variable                             | Edge cases: a revoked key resurrected on restart, rotation semantics, the hash left in manifests |
| Stateless signed tokens (JWT secret)                              | Undoes SPEC-009's per-key revocation                                                             |
| Created by the install SQL                                        | A secret in a SQL file: not workable                                                             |

### 6. Local development

| Option                                                                                                | Cons                                                             |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Compose file in every generated project**, Postgres built locally `FROM postgres:16` + PGDG pg_cron | A short build on first `up`; a few manual steps                  |
| A published dev Postgres image                                                                        | An image to patch, which this spec avoids                        |
| Supabase's Postgres image                                                                             | Large; Supabase-specific roles; unlike plain production Postgres |
| `pgfsm dev up` wrapping the compose file                                                              | More CLI code; deferred, not rejected                            |

## Decision

| Decision                                                                                                                          | Driver                                                                                                        | Why the alternatives lose                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Database: A1 + A2**, with `fsm_core.version()`, a previous-version guard in every upgrade script, and version checks at startup | Portability to managed Postgres; fits the migration tools teams already use                                   | Own image and native extension are blocked on managed providers; B and C can be added later as pure additions |
| **Postgres 15+, installed by the provider's admin login; pg_cron required**                                                       | Every major provider supports pg_cron; one scheduling path                                                    | A fallback scheduler is a second system to test and run                                                       |
| **`pgfsmctl` pure API**; pg_cron registered by the install SQL; scheduler status and repair through admin routes                  | A1/A2 removes SPEC-009's reasons for DB-direct commands; one transport, no database URLs on operator machines | Two tiers mean two code paths and credentials in profiles                                                     |
| **`@pgfsm/api` released like the gateway**                                                                                        | The API becomes required infrastructure; the gateway is a working precedent                                   | Image-only loses `npx`; npm-only pushes image building onto users                                             |
| **First admin key: one-off `pgfsm-api key bootstrap`** (v1)                                                                       | The simplest to build and explain; nothing secret in manifests                                                | The environment-variable option's edge cases; JWTs undo revocation. The env option can be added later         |
| **Local: a compose file in each project, Postgres `FROM postgres:16` + PGDG pg_cron built locally**                               | Local matches production Postgres; nothing image-wise to maintain                                             | A published image needs patching; Supabase's image differs from production. `pgfsm dev up` follows later      |

### The install

- **`fsm_core--<v>.sql`** (full install) and the existing
  **`fsm_core--a--b.sql`** upgrade chain, assembled from `schemas/` and the
  migrations. The repo's own development keeps using Supabase (`db diff`,
  `db
  reset`, `test db`) to author them.
- The SQL **creates the roles, installs or reuses pgmq, requires `ltree` and
  pg_cron, and registers the `fsm_schedule_all_pending` job** idempotently.
- **`fsm_core.version()`** returns the installed version. Each upgrade script
  starts by checking the previous version and refuses to run out of order.
- `pg_jsonschema` becomes a test-only dependency.
- **A2:** the same SQL as a PGXN bundle (`CREATE EXTENSION fsm_core`).

### `@pgfsm/api`

- `packages/fsm-api-ts`, published as `@pgfsm/api` (bin `pgfsm-api`), a GHCR
  image `ghcr.io/pgfsm/api:<v>` (amd64, arm64), `deploy/k8s` manifests, and an
  `api-release.yml` modelled on the gateway's.
- **`/api/v1` is the compatibility contract** with `pgfsmctl`; the API follows
  semver and checks `fsm_core.version()` against its supported range at startup.
- **`pgfsm-api key bootstrap --db-url …`** creates one admin key and prints it
  once; it refuses if an admin key exists, unless `--force`. The key is an
  ordinary, revocable row.
- **`GET/POST /api/v1/admin/scheduler`**: the cron job's status, and an
  idempotent re-registration through a `SECURITY DEFINER` function granted to
  `fsm_admin`.

### `pgfsmctl`, pure API

Removed: `db cron …`, `db key create`, `scheduler run`, `--db-url`, profiles'
`db_url` / `db_password`, `PGFSM_DB_URL` / `DATABASE_URL`, and `tier` /
`PGFSM_TIER` (#663). New: `scheduler status|register` through the admin routes.
`fsm …`, `instance …` and `key …` keep their output and exit codes.
`runFsmScheduler` stays exported as a library for tests.

## Consequences & migration

- **Cheap now:** the API, `@pgfsm/ctl` and `@pgfsm/cli` have never been
  published, so nothing released depends on what's removed; no deprecation
  cycle.
- **Superseded:** SPEC-009 §4–5's two tiers (and the database fallback of #660,
  #661 and #663's pin; the API routes stay), and SPEC-003's fallback process.
  Both specs get a "superseded in part by SPEC-016" note.
- **Harder:**
  - `pgfsmctl` needs a running API; with it down, the fallback is `psql`;
  - deployers must have pg_cron (`shared_preload_libraries` when self-hosting);
  - **the main engineering risk:** the full install and the upgrade chain must
    stay identical, enforced by a CI check that diffs the two schemas;
  - the Supabase-specific pgmq handling must work on both kinds of database.
- **Rollout order:**
  1. The SQL artifact (version function, guards, pg_cron registration,
     `pg_jsonschema` test-only, release workflow, CI on PG 15–17 and both
     routes).
  2. `@pgfsm/api` (the move, `key bootstrap`, the version check, the scheduler
     routes, image, manifests, release workflow).
  3. `pgfsmctl` pure API.
  4. `@pgfsm/cli`'s generated compose file.
  5. Releases: the SQL artifact → `@pgfsm/api` 0.1.0 → `@pgfsm/ctl` 0.1.0 (#454)
     → `@pgfsm/cli` 0.1.0 (#383). `@pgfsm/ctl` stays on hold until step 3.
- **Rollback:** before the first publish, everything can be reverted. After it,
  the SQL artifact is additive: databases installed through Supabase migrations
  keep working.
- **Out of scope:** licensing (a separate decision before the first artifact
  release), the runner (B), the API migrate mode (C), the environment-variable
  bootstrap key, `pgfsm dev up`, and pg_tle/dbdev packaging.

## Acceptance criteria

### The database (A1 + A2)

- [ ] `fsm_core--<v>.sql` installs on clean Postgres **15, 16 and 17** with only
      `ltree` and pg_cron available, as a **non-superuser** login with
      `CREATEROLE` that can create extensions; CI covers all three.
- [ ] Applying every `fsm_core--a--b.sql` in order from the first released
      version reaches the same version as the full install.
- [ ] CI dumps the schema (functions, tables, roles, grants, the cron job) from
      both routes and **fails on any difference**.
- [ ] `fsm_core.version()` returns the installed version; `CREATE EXTENSION`
      records it too.
- [ ] Each upgrade script checks the previous version and fails with
      `fsm_core <x> required, found <y>` when out of order.
- [ ] Without pg_cron the install fails clearly; with it the install registers
      `fsm_schedule_all_pending`, and re-running doesn't duplicate it.
- [ ] pgmq: an existing extension (Supabase) is used; otherwise the vendored SQL
      is installed. Both are tested.
- [ ] `pg_jsonschema` is required only by the pgTAP tests.
- [ ] The PGXN bundle installs with `CREATE EXTENSION fsm_core` and upgrades
      with `ALTER EXTENSION fsm_core UPDATE`, giving the same database as A1.
- [ ] A release workflow publishes the full install, the upgrade scripts and the
      PGXN bundle from a `fsm_core-v<version>` tag.
- [ ] The API, fsmlet and gateway check `fsm_core.version()` at startup and fail
      naming the found version, the required one and the script to apply.

### `@pgfsm/api`

- [ ] `packages/fsm-api-ts`, published as `@pgfsm/api` (bin `pgfsm-api`);
      `npx @pgfsm/api --db-url …` serves `/api/v1`.
- [ ] `ghcr.io/pgfsm/api:<v>` for amd64 and arm64; `deploy/k8s` manifests pin
      it, enforced by a test.
- [ ] `api-release.yml`: preflight → build image → publish npm → tag image →
      verify `npx` and `docker run` report the version.
- [ ] `pgfsm-api key bootstrap` creates one admin key and prints it once;
      refuses if one exists unless `--force`; the key is revocable.
- [ ] `GET/POST /api/v1/admin/scheduler` report and idempotently (re)register
      the cron job through a `SECURITY DEFINER` function granted to `fsm_admin`;
      the API never logs in as the schema owner.

### `pgfsmctl`

- [ ] `db cron`, `db key create`, `scheduler run`, `--db-url`, profiles'
      `db_url`/`db_password`, `PGFSM_DB_URL`/`DATABASE_URL` and `tier` are
      removed. **No command opens a Postgres connection**; a test checks that
      `pgfsmctl` imports neither `pg` nor `@pgfsm/db`.
- [ ] `scheduler status|register` through the admin routes.
- [ ] `fsm …`, `instance …` and `key …` keep their output and exit codes; with
      no API configured they exit 2 naming `--url`/`PGFSM_URL`.
- [ ] `runFsmScheduler` stays exported for tests.

### The local stack

- [ ] `pgfsm create` writes `docker-compose.yml`: Postgres built
      `FROM
      postgres:16` + PGDG pg_cron, the install SQL in
      `/docker-entrypoint-initdb.d`, `@pgfsm/api` and the gateway from released
      images.
- [ ] From a fresh project, `docker compose up` → `npx @pgfsm/api key bootstrap`
      → `pgfsmctl config set` lets `fsm load fsm` and `instance create` succeed;
      CI runs this end to end.
- [ ] Users don't need Supabase; the repo's own development still uses it.

### Docs

- [ ] SPEC-009 and SPEC-003 carry "superseded in part by SPEC-016" notes.
- [ ] A production install guide (psql, Flyway, Supabase migrations, PGXN) and a
      local quick start.

## Implementation

<!-- Filled in after acceptance: links to implementation issues and PRs. -->
