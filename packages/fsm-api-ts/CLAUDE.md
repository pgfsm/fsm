# CLAUDE.md — API Server (`packages/fsm-api-ts/`)

Scoped guidance for the Hono + Deno REST API, published as `@pgfsm/api` (bin
`pgfsm-api`) and `ghcr.io/pgfsm/api` (SPEC-016, #689; it was
`apps/fsm-core-ts-hono-deno` until then). Repo-wide conventions and session
protocol live in the root `CLAUDE.md` / `AGENTS.md`.

## Commands

```bash
deno task start                                    # dev server (deno.ts, ../../.env, --watch)
deno run --allow-all src/cli/index.ts --db-url <url> [--no-auth] [--enable-admin-api]
deno run --allow-all src/cli/index.ts key bootstrap --db-url <owner url> [--name n] [--force]
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres deno test --allow-all test/
deno task build:npm 0.1.0                          # dnt → dist/ (needs @pgfsm/db's version on npm)
docker build -f packages/fsm-api-ts/deploy/docker/api.Dockerfile -t pgfsm/api:dev .   # from the repo root
```

`test/` needs a database whose `DATABASE_URL` user is the schema owner (a member
of every `fsm_*` role), e.g. local Supabase; without it the tests skip. CI runs
them in the pgTAP job, and type-checks `deno.ts`, `src/cli/index.ts` and `test/`
in the Deno job (blocking).

## Releasing

`api-release.yml`, from an `api-v<version>` tag, mirrors the gateway's: bump
`deno.json`'s version and the image tag in `deploy/k8s/base/*.yaml`
(`test/deploy-manifests.test.ts` checks they match) in a PR; after it merges and
main's CI passes, push the tag. Preflight refuses if the `@pgfsm/db` /
`@pgfsm/logging` versions it depends on aren't on npm or changed since their
release tags, so release those first.

## Structure

- `app.ts` — mounts `createApp()` under `/api/v1` (the CLI's `--url-path-prefix`
  default too; #675)
- `deno.ts` — Deno entry point; configures LogTape before `app.ts` loads (must
  happen first — `app.ts` emits logs at module load time)
- `node.ts` — Node entry point (HTTP/2, separate from the Deno path)
- `seconddeno.ts` — second server instance on `PORT + 1`, used to test
  advisory-lock / `lock_workflow_instance` behavior under concurrent access
- `env.ts` — Zod-validated environment config (`DB_TYPE`, `PORT`, `LOG_LEVEL*`,
  `OTEL_*`, etc.), read once at import. `SUPABASE_URL`/`SUPABASE_ANON_KEY` are
  required only for `DB_TYPE=supabase*`
- `mod.ts` — the npm package's library export (`PACKAGE_VERSION` only)
- `logger.ts` — composition-root LogTape configuration for this process
  (`configureApiLogger()`), via `@pgfsm/logging`
- `lib/create-app.ts` — app factory: its own pool (or `options.pool`),
  middleware (logging, request IDs, CORS, OTel tracing), API-key auth and the
  admin routes. Serves HTTP only: there's no embedded fsmlet (root `CLAUDE.md`
  #3; it stopped compiling after #341 and was removed in #472)
- `lib/create-router.ts` — `createRouter()`, kept apart from `create-app.ts`
  (which reads `env.ts` at import) so route modules import and test without the
  API's environment
- `lib/configure-open-api.ts` — OpenAPI/Scalar docs setup (available at
  `/docs`); `info.license` and `externalDocs` carry the licence and source URL
- `lib/license.ts` — the licence notice (SPEC-017): `AGPL-3.0-only` and the
  source URL (`PGFSM_SOURCE_URL`, default `https://github.com/pgfsm/fsm`),
  reported by `GET /` (`routes/index.route.ts`'s `createIndexRouter`), the
  OpenAPI document and the "API ready" log line, for AGPL-3.0 §13. A modified
  API sets `PGFSM_SOURCE_URL` to its own source
- `lib/constants.ts`, `lib/types.ts` — shared app-level constants/types
- `middlewares/logtape-logger.ts` — HTTP access logging via `@logtape/hono`
- `middlewares/otel-trace.ts` — OpenTelemetry span per request (enabled via
  `OTEL_DENO`)
- `middlewares/pino-logger.ts` — legacy Pino logger; commented out in
  `create-app.ts`, superseded by `logtape-logger.ts`
- `middlewares/supabase.ts` — Supabase client middleware (only with `--no-auth`)
- `middlewares/api-key-auth.ts` — `apiKeyAuth()`: bearer key → `hashApiKey` →
  `verify_api_key` (cached ≤ 30 s), then the rest of the request runs inside
  `withRole(key's role)` with `c.get("db")` set to that transaction
- `routes/instances/` — FSM instances (operator key; #675): `GET /instances`
  (`?fsm_name&fsm_version&status&limit`, filtered and limited in the database,
  default 50, max 1000; #661), `GET /instances/{id}`, `POST /instances`
  (`{ fsm_name, fsm_version, input }`), `POST /instances/{id}/events`
  (`{ type, ...payload }`), `/resume`, `/stop`. Every `/instances/{id}…` route
  answers 404 for an unknown instance (checked with `getFSMData` first:
  `get_fsm_data_resolve_state_value_v2` raises)
- `routes/definitions/` — loaded definitions, read-only (operator key; #661):
  `GET /definitions` (`?fsm_name&fsm_version`, each with its SHA-256 digest),
  `GET /definitions/{fsmName}` (its versions; 404 if none),
  `GET /definitions/{fsmName}/versions/{fsmVersion}` (its fsm.json; 404).
  `fsm_operator` reads `fsm_core.fsm_json` from migration 2.2.2
- `routes/admin/` — `POST /admin/definitions`, `GET|POST /admin/keys`,
  `DELETE /admin/keys/{idOrName}`, `GET|POST /admin/scheduler` (the pg_cron
  job's status, and idempotent (re)register with an optional `{ schedule }`,
  through `scheduler_job_status_v2` / `register_scheduler_job_v2`, SECURITY
  DEFINER for `fsm_admin`; SPEC-016) (admin key; mounted only with
  `--enable-admin-api`)
- `test/api-key-auth.test.ts` — auth, roles, rollback, admin routes, `createApp`
  startup checks
- `test/scheduler-and-bootstrap.test.ts` — `/admin/scheduler` and
  `bootstrapAdminKey`; `test/deploy-manifests.test.ts` — the manifests pin this
  version's image
- `src/cli/index.ts` — the `pgfsm-api` bin: `[serve]` (default) and
  `key bootstrap`, `--version`. Serving checks `fsm_core.version()` first
  (`requireFsmCoreVersion`). SIGTERM/Ctrl-C drain in-flight requests, close the
  pool and exit 0; a second signal exits 130. Flags are copied into the env
  before `env.ts`/`logger.ts` load
- `src/cli/key-bootstrap.ts` — `bootstrapAdminKey`: the first admin key, as a
  login that can act as `fsm_admin` (the database owner); refuses while a live
  admin key exists unless `force`
- `src/cli/serve.ts` / `serve.node.ts`, `invocation.ts` / `.node.ts`,
  `version.ts` / `version.node.ts` (generated, gitignored) — swapped by
  `scripts/build-npm.ts`'s `mappings` for the npm bin: `Deno.serve` vs
  `@hono/node-server`, the help text's invocation, the version
- `deploy/docker/api.Dockerfile` — `deno compile` onto distroless, non-root;
  `deploy/k8s/` — `pgfsm-api` and the internal `pgfsm-api-admin` Deployments
- `stoker-src/` — OpenAPI helper utilities

## Key Dependencies

- **Hono** with `@hono/zod-openapi` — REST framework + type-safe routes
- **Zod** — runtime validation
- **LogTape** (`@logtape/logtape`, `@logtape/hono`, `@logtape/otel`) via
  `@pgfsm/logging` — structured logging (see
  `packages/fsm-logging-ts/CLAUDE.md`)
- **OpenTelemetry** (`@opentelemetry/api`) — request tracing, opt-in via
  `OTEL_DENO`

## Environment Variables (`DB_TYPE` is key)

- `"postgres"` — direct PostgreSQL connection
- `"supabase"` — Supabase JS client
- `"supabase_and_postgres"` — both clients available

See `env.ts` for the full Zod schema (`PORT`, `LOG_LEVEL` + per-category
overrides, `OTEL_*`, `CORS_ORIGIN`, etc.).

## API keys and roles (SPEC-009 §3)

Auth is **on by default**. Every `/instances*` and `/definitions*` request needs
`Authorization: Bearer <key>`, an operator or admin key, and `/admin/*` needs an
admin key. A request runs in one transaction under `SET LOCAL ROLE` with the
key's role, so the database grants (`packages/database-src/CLAUDE.md`, "Access
control") are what's enforced, not route code. A handler that throws or answers
5xx rolls its writes back.

- `PGFSM_NO_AUTH=true` / `--no-auth`: every request runs as the pool's login.
  Local development only: refused when `NODE_ENV=production`. It's also the only
  mode that supports `DB_TYPE=supabase*`; auth needs `DB_TYPE=postgres`.
- `PGFSM_ENABLE_ADMIN_API=true` / `--enable-admin-api`: mounts `/admin/*`. At
  startup the pool's login must be able to act as `fsm_admin`, or the API exits
  naming the `GRANT`.
- `PGFSM_AUTH_CACHE_TTL_MS` (default and max 30000): how long a verification is
  reused, which is also how long a revoked key keeps working. 0 disables it.
- In production the pool logs in as `fsm_authenticator` (NOINHERIT; a deployment
  grants `fsm_admin` to it only on the internal, admin-enabled Deployment).
  Logging in as `postgres` works, but the API warns at startup that the login
  inherits privileges.
- The first admin key comes from the database side:
  `pgfsm-api key bootstrap --db-url <owner url>` (SPEC-016). After that, keys
  are managed through `/admin/keys` (`pgfsmctl key create|list|revoke`).
