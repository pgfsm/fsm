# SPEC-009: CLI Surface and Access Model — `pgfsmctl` via URL + Role-Scoped API Keys

| Field   | Value                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status  | Accepted                                                                                                                                                                       |
| Date    | 2026-10-05                                                                                                                                                                     |
| Authors | Niraj, Claude                                                                                                                                                                  |
| Issue   | #466                                                                                                                                                                           |
| Affects | `packages/fsm-ctl-ts`, `apps/fsm-core-ts-hono-deno`, `packages/database-src` (roles, grants, `api_keys`), `packages/fsm-core-db-ts`, `packages/fsm-cli-ts` (generated scripts) |
| Amends  | SPEC-005 (`pgfsmctl` command surface), SPEC-008 (`actors status` flags and exit codes)                                                                                         |

---

## Problem

Neither `@pgfsm/cli` (`pgfsm`) nor `@pgfsm/ctl` (`pgfsmctl`) has been published
to npm yet (#454 is on hold for this spec). That makes this the last cheap point
to settle three things that become breaking changes after a release.

1. **Every `pgfsmctl` command needs a raw Postgres URL, and in practice that's a
   superuser.**
   - `fsm_core` has no least-privilege roles. The only grants file
     (`20250319134653_fsm_core_supabase_access_update.sql`) is fully commented
     out.
   - Functions keep Postgres' default `EXECUTE` to `PUBLIC`.
   - So anyone who runs `pgfsmctl instance send` or `fsm load` has the
     `postgres` password. That password also allows DDL and dropping the schema,
     and it reaches pgmq and pg_cron.
2. **The REST API (`apps/fsm-core-ts-hono-deno`) has no authentication.**
   - Its routes (`GET/POST /fsm`, `/fsm/send`, `/fsm/stop`, `/fsm/dispatch`,
     `/fsm/resume-dispatch`) are open to anyone who can reach the port.
   - So the only way to give someone a narrow ability today is to give them
     network access to Postgres.
3. **The CLI's conventions aren't defined.** There are no named targets
   (profiles), no machine-readable output, and only exit codes 0/1. There's also
   a flag collision waiting to happen: `instance create --context <json>` means
   the FSM's initial context, while every comparable ops CLI uses
   `--context`/`--profile` for the target.

Who it affects:

- operators running `pgfsmctl` from laptops or CI;
- platform teams deploying pgfsm on Kubernetes (SPEC-007), who have to put a
  superuser URL into a Job's Secret;
- generated projects (`db:load`, `db:pgcron`), whose first `.env` teaches users
  to paste the superuser URL.

## Constraints

- **Function-boundary access control** (database ADR-001, no RLS). Callers reach
  `fsm_core` only through functions, and access is `GRANT EXECUTE` on specific
  functions. This spec adds roles and grants. It adds no row policies.
- **Connection minimization** (root `CLAUDE.md` #4, ADR-003). Per-role access
  must not mean a pool per role or a connection per operator.
- **One compatibility axis per package** (SPEC-005). `@pgfsm/ctl` tracks
  `@pgfsm/db` and the migrations; `@pgfsm/cli` tracks the compiler and SDKs. Ops
  commands must not move into `pgfsm`, and project-aware commands must not move
  into `pgfsmctl`.
- **Bootstrap must not depend on the API.** Deploy order is migrate → load
  definitions → register pg_cron → start the API and workers (SPEC-003,
  SPEC-006). A failed deploy has to be fixable without a healthy API.
- **Worker ↔ gateway auth is separate** (SPEC-007). The gateway's bearer tokens
  (`--auth-token-file/dir`) authenticate worker processes to the gateway. They
  are machine credentials with a different audience, lifetime and rotation path
  from operator/admin API keys, and this spec doesn't change them.
- **Supabase and plain Postgres both work.** Roles, grants and key storage must
  work on Supabase (where the owner is `postgres`, not a true superuser) and on
  self-hosted Postgres.
- **The Hono app embeds an fsmlet today.** `lib/create-app.ts` requires
  `fsmConfig` "to start the fsmlet and obtain a DB pool". The API currently
  shares the fsmlet's pool.

## Options considered

The options are for the overall shape. Sub-decisions are listed after them.

### Option A — Do nothing: DB-direct with documented URLs

Keep `pgfsmctl` DB-direct. Document "use a non-superuser" and leave role setup
to each deployment.

- **Pros:** No work, and nothing new to run.
- **Cons:** Every deployment invents its own grants, or more likely doesn't.
  Default `EXECUTE` to `PUBLIC` makes any role effectively an operator. The API
  stays unauthenticated.

### Option B — Postgres roles only, no API tier

Ship `fsm_admin` / `fsm_operator` roles and grants. Each operator gets their own
Postgres login that is granted one of them. `pgfsmctl` stays DB-direct forever.

- **Pros:** Small. Postgres enforces everything. There's no new server code, and
  revocation is `REVOKE`/`DROP ROLE`.
- **Cons:**
  - Every operator, CI runner and laptop needs network access to Postgres.
  - Each `pgfsmctl` call is a new DB connection, which goes against #4 as usage
    grows.
  - The credential is a Postgres password: no key prefix to recognize in a leak,
    no `last_used_at`, and issuing one needs DB-admin rights.
  - The REST API stays unauthenticated.

This option is still the **first step of the chosen option**: the chosen option
uses these same roles underneath.

### Option C — kubectl-style: kubeconfig contexts, everything through the API

Model `pgfsmctl` on kubectl: verb-resource grammar (`get instances`),
`~/.kube/config`-style contexts, every command through the API (including
migrations and pg_cron).

- **Pros:** A familiar mental model for Kubernetes users, with one auth path.
- **Cons:**
  - kubectl's grammar fits a generic resource API server, and pgfsm doesn't have
    one. Its nouns are already noun-verb.
  - Routing bootstrap commands through the API breaks the bootstrap constraint.
  - It forces the public API process to hold DDL and pg_cron rights permanently.

### Option D — Supabase-style single binary

Fold ops into `pgfsm` (`pgfsm db push`-style), as SPEC-005 Option B proposed.

- **Pros:** One tool and one release line.
- **Cons:** SPEC-005 already rejected this, and its reasons still hold.
  - It mixes two compatibility axes.
  - Ops Job images would carry the compiler tree.
  - Ops commands don't need a project.

### Option E — Two tiers: dbosctl-shaped CLI, Supabase-style URL + role-scoped key (chosen)

- `pgfsmctl`'s UX is modeled on **dbosctl**:
  - noun-verb commands;
  - profiles;
  - `-o table|json|ids`;
  - documented exit codes;
  - DB-direct `sysdb`-style commands alongside API commands.
- Its access model is modeled on **Supabase**:
  - a product URL (`PGFSM_URL`, like `SUPABASE_URL`);
  - a key whose **role** decides what it can do (`PGFSM_API_KEY`, like the
    `service_role`/`sb_secret_` key);
  - the server switches to that Postgres role per request, the way PostgREST's
    `authenticator` does.
- Commands split into two tiers by what they are:
  - **DB-direct tier** (`PGFSM_DB_URL`): bootstrap and infra. That's pg_cron,
    the first admin key, migrations (reserved) and the scheduler fallback. These
    run from CI or a Kubernetes Job with a scoped role, never through the API.
  - **API tier** (`PGFSM_URL` + `PGFSM_API_KEY`): everything else. Phase 1 is
    `fsm load` and key management with an **admin** key. Phase 2 adds
    `instance …`, `fsm list/get` and SPEC-008's `actors status` with an
    **operator** key.

- **Pros:**
  - Operators never need Postgres reachability or a Postgres password.
  - Keys are individually revocable and recognizable (`pgfsm_admin_…`).
  - The public API holds no rights beyond what the presented key's role has, and
    Postgres grants still enforce them.
  - One small pool serves every role (`SET LOCAL ROLE`), which keeps #4.
  - Bootstrap stays independent of the API.
- **Cons:**
  - Two transports in one CLI, so the resolution rules must be very clear.
  - The API process can switch to `fsm_admin`, so a compromised API process can
    act as admin (mitigated below).
  - Key management is new surface: a table, functions, CLI and endpoints.

### Sub-decision 1 — Key format

| Option                                    | Verdict                                                                                                                                                                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Opaque random key, SHA-256 hash in DB** | **Chosen.** One lookup per request. Revocation is per key. Keys carry a visible prefix, so secret scanners can match them. This is the model Supabase moved to (`sb_secret_…`) away from JWTs.                                   |
| Signed JWT with a `role` claim            | Rejected. There's no lookup, but a leaked key can only be revoked by rotating the signing secret, which revokes every key. That's the reason Supabase's legacy `service_role` JWT is being retired.                              |
| Static key files mapped to roles          | Rejected for this tier. It's simple and matches SPEC-007's gateway tokens, but there's no CLI key management, rotation means redeploying Secrets, and there's no `last_used_at`. It's still right for SPEC-007's machine tokens. |

### Sub-decision 2 — Environment variable names

| Option                                                       | Verdict                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`PGFSM_URL` + `PGFSM_API_KEY` (+ `PGFSM_DB_URL`)**         | **Chosen.** The URL names the server, not the CLI, so SDKs and apps can reuse it the way everything reads `SUPABASE_URL`. A CLI call acts as one identity, so it reads one key variable, and the key's role decides access (like `DBOS_TOKEN`). Deployments can still name their mounted Secrets `PGFSM_ADMIN_KEY` / `PGFSM_OPERATOR_KEY` and map one into `PGFSM_API_KEY`. |
| `PGFSM_CTL_URL` + `PGFSM_CTL_ADMIN_KEY` (+ `…_OPERATOR_KEY`) | Rejected. It ties the server URL to one client, and the CLI would have to guess which key variable a command needs.                                                                                                                                                                                                                                                         |
| `PGFSM_URL` + `PGFSM_ADMIN_KEY` / `PGFSM_OPERATOR_KEY`       | Rejected for the CLI. It's the Supabase-literal naming, which suits an app server holding both keys. A CLI holding both would quietly use admin for operator commands.                                                                                                                                                                                                      |

### Sub-decision 3 — Where admin endpoints run

| Option                                             | Verdict                                                                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Same Hono app, off unless `--enable-admin-api`** | **Chosen.** One codebase. A public Deployment runs without admin routes, and an internal one turns them on. When admin is off, the API's login role isn't granted `fsm_admin` at all (see Decision §3). |
| Separate admin service                             | Rejected for now. It isolates better, but it's another app, image and Deployment for two endpoints. The flag keeps that split possible later without changing the CLI.                                  |
| Same app, always on                                | Rejected. Every API process, including public ones, could become `fsm_admin`.                                                                                                                           |

## Decision

**Option E.** The deciding driver is **least privilege without breaking
bootstrap**:

- Option A gives no least privilege at all.
- Option B gives it only to people who can reach Postgres.
- Option C gets it by making bootstrap depend on the API and by giving the
  public process DDL rights.
- Option E puts each command in the tier that matches what it is, and uses
  Postgres grants (Option B's roles) as the single place access is enforced.

Supporting drivers:

- **Unreleased now, so breaking changes are free.** The `--context` rename, the
  noun moves and the exit-code table cost nothing today and would need a major
  version later. That's why #454 is on hold.
- **Two established models to copy.** dbosctl is the closest analogue: a
  durable-workflow engine on Postgres, whose ops CLI has a DB-direct `sysdb`
  tier and an API tier. Supabase's URL-plus-role-key model is the one pgfsm
  users already know.

### 1. Roles (migration in `packages/database-src`)

| Role                | Login                | Granted                                                                                                                                                                                                                                                              | Used by                                            |
| ------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `fsm_operator`      | NOLOGIN              | `EXECUTE` on the instance functions behind the `/fsm/*` routes and `pgfsmctl instance` (create, send, stop, resume, enqueue, get state); `SELECT` on `fsm_instance`, `async_operation_meta`                                                                          | operator keys, via the API                         |
| `fsm_admin`         | NOLOGIN              | `fsm_operator`, plus `EXECUTE` on the three `load_fsm_*_from_json_v2` functions and the key-management functions; `SELECT` on `fsm_json`                                                                                                                             | admin keys, via the API; DB-direct break-glass     |
| `fsm_worker`        | NOLOGIN              | `EXECUTE` on the claim/schedule/microstep/lock/archive functions the fsmlet, `scheduler run` and the gateway call; DML on the two workerlet tables; `SELECT` on `fsm_json`; pgmq `USAGE` + `SELECT`/`UPDATE` on queue tables (the fsmlet calls `pgmq.read` directly) | deployment-created logins for workers and gateways |
| `fsm_authenticator` | LOGIN, **NOINHERIT** | membership in `fsm_operator`; membership in `fsm_admin` **only** where admin is enabled; `EXECUTE` on `verify_api_key`                                                                                                                                               | the Hono API's pool                                |

- **Entry points are `SECURITY DEFINER`** with
  `search_path = fsm_core, pgmq, public, extensions, pg_temp`. The 27 functions
  TypeScript calls directly switched in 2.1.0 (#469). Database ADR-001 had
  assumed they already were, but every `fsm_core` function ran as the caller, so
  `EXECUTE` alone would not have been enough. Internal helpers stay invoker and
  run as the owner when called from an entry point.
- **Table privileges only where `@pgfsm/db` touches a table directly**
  (workerlet heartbeats, instance listing, `fsm_json` reads), as listed above.
  Every state-changing write to instances and events goes through a definer
  function.
- `EXECUTE` is revoked from `PUBLIC` on every `fsm_core` function the owner owns
  (extension members such as `pg_jsonschema`'s are skipped). There's **no
  `ALTER DEFAULT PRIVILEGES`**: per-schema defaults can only add privileges, and
  a global revoke would also hit the owner's functions outside `fsm_core`. A
  pgTAP test fails CI on any `fsm_core` function executable by `PUBLIC`.
- `CREATE ROLE` and function grants aren't captured by `supabase db diff`, so
  they're kept in `schemas/40_access_control/` and copied by hand into the
  versioned migration. The pgTAP test catches drift.
- The schema owner is granted membership in the four roles (granted by name: on
  Supabase PG 15.8 `GRANT … TO CURRENT_USER` segfaults the backend). Supabase's
  `postgres` isn't a superuser, so without membership it couldn't `SET ROLE` to
  test them.
- **pg_cron and migrations are not granted to any of these roles.** They run as
  the schema owner (Supabase: `postgres`) in the DB-direct tier.
- The migration creates `fsm_authenticator` without a password.
  - Deployments set one: `ALTER ROLE … PASSWORD`, or on Supabase a custom role.
  - They grant `fsm_admin` to it on the internal Deployment only.
  - Granting is deployment configuration. A second login role
    (`fsm_authenticator_admin`) is the documented pattern when public and
    internal API Deployments share a database.

### 2. API keys (`fsm_core.api_keys` + functions)

```
fsm_core.api_keys(
  id uuid primary key, name text unique not null,
  role text not null check (role in ('fsm_admin','fsm_operator')),
  prefix text not null,        -- role prefix + 8 key chars, shown in `key list`
  key_hash bytea not null unique,  -- sha256(key)
  created_at timestamptz not null default now(),
  last_used_at timestamptz, revoked_at timestamptz)
```

- **Format:** `pgfsm_admin_<64 hex chars>` or `pgfsm_op_<…>` (two
  `gen_random_uuid()` values, 244 random bits). The plaintext is returned
  **once**, at creation, and never stored.
- **Functions** (`SECURITY DEFINER`, `search_path = fsm_core, pg_temp`):
  - `create_api_key(name, role)` returns the plaintext. Admin only. Randomness
    comes from core `gen_random_uuid()` and the hash from core `sha256()`, so
    pgcrypto isn't needed.
  - `revoke_api_key(id_or_name)` and `list_api_keys()`. Admin only.
  - `verify_api_key(key_hash)` returns the role, or null when the key is unknown
    or revoked. It's granted to `fsm_authenticator` only, and it updates
    `last_used_at` at most once a minute.
- **Bootstrap:** the first admin key is created DB-direct
  (`pgfsmctl db key create`) by the schema owner, the same way a Supabase
  project's keys are minted outside its API.

### 3. Hono API (`apps/fsm-core-ts-hono-deno`)

- **Auth middleware.** It reads `Authorization: Bearer <key>`, hashes the key,
  and calls `verify_api_key`. A missing or unknown key gets `401`. A role
  without access to the route gets `403`. Verification results may be cached
  in-process for **≤ 30 s**, which is the documented upper bound on how long a
  revoked key keeps working.
- **Per-request role.** Every handler's DB work runs in
  `BEGIN; SET LOCAL ROLE <key role>; …; COMMIT`. `SET LOCAL` is scoped to the
  transaction, so one pool logged in as `fsm_authenticator` serves every role.
  Postgres grants, not route code, are the enforcement point.
- **Routes:**
  - Existing `/fsm/*` routes need `fsm_operator`, which admin keys inherit.
  - New admin routes exist only with `--enable-admin-api` /
    `PGFSM_ENABLE_ADMIN_API=true`:
    - `POST /admin/fsm/load`, whose body is the same batch `@pgfsm/db`'s
      `loadFsmDefinitions` takes;
    - `GET /admin/keys`, `POST /admin/keys`, `DELETE /admin/keys/:id`.
  - At startup, with admin enabled, the API checks that its login role is a
    member of `fsm_admin`, and fails fast if it isn't.
- **`--no-auth`** (local dev only) skips the middleware and runs handlers as the
  pool's own role. It logs a warning at startup and refuses to start when
  `NODE_ENV` (the variable `env.ts` already validates) is `production`.
- **Embedded fsmlet.** The API pool logs in as `fsm_authenticator`, and the
  embedded fsmlet keeps its own pool with a `fsm_worker` login. That means two
  small pools in that process. This is an accepted, temporary cost to #4.
  Splitting the fsmlet out of the API process is a follow-up and isn't part of
  this spec.
- **Scope:** auth applies to the `DB_TYPE=postgres` path. Startup refuses
  `DB_TYPE=supabase*` with auth enabled until that path is migrated.

### 4. `pgfsmctl` command surface

Noun-verb throughout. The **`db` noun is always DB-direct**, so the transport is
visible in the command:

| Command                                                    | Tier                         | Role needed    | Phase | Was                                 |
| ---------------------------------------------------------- | ---------------------------- | -------------- | ----- | ----------------------------------- |
| `db cron register \| unregister \| status`                 | DB-direct                    | schema owner   | 1     | `pgcron …`                          |
| `db key create --name <n> --role admin\|operator`          | DB-direct                    | schema owner   | 1     | new (bootstrap)                     |
| `db migrate`                                               | DB-direct                    | schema owner   | later | reserved                            |
| `scheduler run`                                            | DB-direct                    | `fsm_worker`   | 1     | unchanged (SPEC-003 fallback)       |
| `fsm load <folder>`                                        | API (break-glass: DB-direct) | `fsm_admin`    | 1     | DB-direct only                      |
| `key create \| list \| revoke`                             | API                          | `fsm_admin`    | 1     | new                                 |
| `config set \| use \| list \| show`                        | local                        | —              | 1     | new                                 |
| `completion <shell>`, `version`                            | local                        | —              | 1     | `--version` only                    |
| `instance create \| resume \| send \| stop \| list \| get` | API                          | `fsm_operator` | 2     | DB-direct (create/resume/send/stop) |
| `fsm list \| get`, `actors status` (SPEC-008)              | API                          | `fsm_operator` | 2     | `actors status` DB-direct           |

- In phase 1, `instance …` and `actors status` stay DB-direct (`--db-url`) with
  today's behavior. In phase 2 they move to the API and keep `--db-url` as
  break-glass, the same pattern as `fsm load`.
- `instance create --context <json>` becomes **`--input <json>`**. That matches
  xstate v5's `input` and frees `--context`.

### 5. Target resolution

For each command:

1. Explicit flags (`--url`/`--api-key`, or `--db-url`) pick the target and the
   tier. Passing a tier the command doesn't support is a usage error (exit 2).
2. Otherwise environment variables:
   - API tier: `PGFSM_URL` + `PGFSM_API_KEY`;
   - DB-direct tier: `PGFSM_DB_URL`, falling back to `DATABASE_URL`;
   - `./.env` is loaded first, as today.
3. Otherwise the active profile (`--profile` / `PGFSM_PROFILE` / `config use`).
4. For a command that supports both tiers (`fsm load`; phase-2 `instance …`):
   the API wins whenever an API target resolves, and DB-direct is used only when
   no API target exists.
   - So a generated project's local `.env` with only `DATABASE_URL` keeps
     working with no API running.
   - The tier used is logged at `info`.

**Profiles:**

- `~/.config/pgfsm/config.yaml` (OS config dir) holds `url` and/or `db_url`
  without passwords.
- `credentials.json` (mode 0600) holds API keys and DB passwords, written by
  `config set <p> --api-key-stdin` / `--db-password-stdin`.
- Profile files never hold a secret passed on the command line.

### 6. Output and exit codes

- **Output.** Data goes to stdout and logs go to stderr. `-o table` is the
  default; `-o json` is the raw response and is never truncated; `-o ids` prints
  one id per line. SPEC-008's `--json` becomes `-o json`.
- **Exit codes** (dbosctl's table, plus one):

| Code | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| 0    | Success                                                               |
| 1    | General error (DB/API unreachable, server error)                      |
| 2    | Usage error (bad flags or arguments, unsupported tier)                |
| 3    | Authentication or authorization failed (401/403, or Postgres `42501`) |
| 4    | Not found (404, or unknown FSM/instance/key)                          |
| 5    | Check failed: a status or check command ran and found a problem       |
| 130  | Interrupted (Ctrl-C)                                                  |

SPEC-008 (#420) follows this: `pgfsmctl actors status` exits **5**, not 2, when
an actor is `no_worker`/`backlogged`, and `pgfsm check` exits 5 when it finds
stale files, missing actors or placeholders. Both take `-o json` instead of
`--json`.

### 7. `pgfsm` (project CLI) and generated projects

`pgfsm`'s commands are unchanged (SPEC-004). It adopts the same exit-code table
(0/1/2/130, 4 for a missing project, and 5 for a failed `pgfsm check`, SPEC-008)
and the same stdout/stderr split. Generated projects change as follows:

- `package.json` scripts:
  - `db:load` → `pgfsmctl fsm load fsm`. It picks its tier by §5.
  - `db:pgcron` → `pgfsmctl db cron register`.
  - New: `db:key` → `pgfsmctl db key create --name local-admin --role admin`.
- `.env.example` lists `PGFSM_URL`, `PGFSM_API_KEY`, `PGFSM_DB_URL`, with a
  comment that local dev needs only `PGFSM_DB_URL`/`DATABASE_URL`.
- `pgfsm init` (#385), `pgfsm sync` (#390) and `npm create @pgfsm` (#384) stay
  separate work items. This spec only fixes the conventions they inherit.

## Consequences & migration

**What gets harder:**

- Deployments must create logins for `fsm_authenticator` and `fsm_worker` (or
  keep using the owner, which still works because superusers and owners bypass
  grants). The reference K8s manifests (#457) need these Secrets.
- Revoking `EXECUTE` from `PUBLIC` breaks any existing non-owner, non-superuser
  caller that relied on it. Today every component connects as `postgres`, so
  nothing breaks in this repo. External users on custom roles must grant
  `fsm_worker`.
- The API can switch to `fsm_admin` wherever admin is enabled. A compromise of
  that internal process equals admin. This is mitigated by:
  - keeping the flag off in public Deployments;
  - the separate login-role pattern;
  - admin keys never being accepted on a process without admin.
- Key management is new surface to test and document.
- The embedded fsmlet temporarily needs a second pool.

**Migration (all pre-release, no external users of the CLI yet):**

1. Migration: roles, grants, `REVOKE … FROM PUBLIC`, `api_keys` and its
   functions. Regenerate types per `docs/schema-change-propagation.md`.
2. `@pgfsm/db`:
   - `createApiKey` / `revokeApiKey` / `listApiKeys` / `verifyApiKey`;
   - a `withRole(pool, role, fn)` helper for `SET LOCAL ROLE`.
3. Hono API:
   - auth middleware and the per-request role;
   - admin routes behind the flag;
   - `--no-auth`;
   - the second pool for the embedded fsmlet.
4. `pgfsmctl`:
   - `pgcron` → `db cron`;
   - `db key create`, `key …`, `config …`, `completion`;
   - `fsm load` over the API;
   - `--input`, `-o`, exit codes.
5. `@pgfsm/cli`: generated scripts and `.env.example`. Regenerate
   `test-apps/debug-only`.
6. Release `@pgfsm/db` → `@pgfsm/ctl` 0.1.0 (#454) → `@pgfsm/cli`, at most three
   tags per push.
7. Phase 2 (separate issues): operator grants, `instance`/`fsm list|get`/
   `actors status` over the API, operator keys.

**Rollback:**

- `--no-auth`, plus pointing the pool's login at the owner, restores today's API
  behavior without a code revert.
- The migration's down path re-grants `EXECUTE` to `PUBLIC` and drops the roles
  and `api_keys`. Nothing else references them.
- `pgfsmctl`'s DB-direct break-glass (`--db-url`) means a broken API never
  blocks loading definitions.

**Out of scope:**

- OIDC / `pgfsmctl login|logout|whoami`. Those verbs are reserved for a later
  spec, as another way to obtain a bearer token for a URL profile.
- Per-tenant or per-FSM key scopes.
- Splitting the fsmlet out of the API process.
- SPEC-007's gateway tokens.

## Acceptance criteria

- [ ] After the migration, no function in `fsm_core` is executable by `PUBLIC`.
      A CI test asserts this with `has_function_privilege('public', …)` over
      every function in the schema, so a new function that forgets the default
      fails CI.
- [ ] A login granted only `fsm_operator` gets SQLSTATE `42501` calling the
      definition-load function or `create_api_key`. A login granted `fsm_admin`
      succeeds.
- [ ] `create_api_key` returns a `pgfsm_admin_…`/`pgfsm_op_…` plaintext exactly
      once. `api_keys` stores only its SHA-256 and a display prefix.
      `verify_api_key` returns null after `revoke_api_key`.
- [ ] The API returns `401` without a key or with an unknown or revoked key
      (revoked keys within ≤ 30 s), and `403` for an operator key on an admin
      route.
- [ ] With `--enable-admin-api` off, `/admin/*` routes return `404`, and an
      admin key works on `/fsm/*` as operator.
- [ ] With `--enable-admin-api` on and the login role not a member of
      `fsm_admin`, the API exits at startup with a message naming the missing
      grant.
- [ ] Concurrent requests with admin and operator keys on one pool each run with
      their own role. A test asserts `current_user` per request under
      concurrency, so `SET LOCAL` never leaks across pooled connections.
- [ ] `pgfsmctl fsm load fsm` with `PGFSM_URL` + an admin key loads through the
      API. With only `DATABASE_URL` it loads DB-direct. With both, it uses the
      API and logs the tier. `--db-url` forces DB-direct.
- [ ] `pgfsmctl db key create` against a fresh database prints a working admin
      key, which `pgfsmctl key list` (API tier) then shows by prefix.
- [ ] `pgfsmctl config set/use/list/show` work. `credentials.json` is created
      with mode 0600. Precedence is flag > env > profile, covered by tests.
- [ ] Every command supports `-o json`, which is valid JSON on stdout with logs
      only on stderr. `-o ids` prints one id per line where the output is a
      list.
- [ ] Exit codes match §6, with tests for 2 (bad flag), 3 (bad key), 4 (unknown
      instance or key), and 5 (`actors status` once SPEC-008 lands).
- [ ] `instance create --context` is gone and `--input` works. `pgcron …` is
      gone and `db cron …` works. `--help` lists the tier for each command.
- [ ] A freshly generated project's `db:load`, `db:pgcron` and `db:key` scripts
      work against local Supabase with only `DATABASE_URL` set.
- [ ] `@pgfsm/ctl` 0.1.0 is published with this surface (#454 unblocked).

## Implementation

<!-- Filled in after acceptance: links to implementation issues and PRs. -->
