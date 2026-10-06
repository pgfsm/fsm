# CLAUDE.md — API Server (`apps/fsm-core-ts-hono-deno/`)

Scoped guidance for the Hono + Deno REST API. Repo-wide conventions and session
protocol live in the root `CLAUDE.md` / `AGENTS.md`.

## Commands

```bash
deno run --allow-all --env-file=./../../.env --watch deno.ts   # dev server (port from env, default 9999)
deno run --allow-all src/cli/index.ts --db-url <url> [--no-auth] [--enable-admin-api]
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres deno test --allow-all test/
```

`test/` needs a database whose `DATABASE_URL` user is the schema owner (a member
of every `fsm_*` role), e.g. local Supabase; without it the tests skip. CI runs
them in the pgTAP job, and type-checks `deno.ts`, `src/cli/index.ts` and `test/`
in the Deno job (blocking).

> `deno.json`'s `start`/`cli` tasks point at `main.ts` / `src/cli/index.ts` —
> `main.ts` doesn't exist in this tree, so `deno task start` fails. Run
> `deno.ts` directly (shown above) until that task is fixed.

## Structure

- `app.ts` — mounts `createApp()` under `/fsm`
- `deno.ts` — Deno entry point; configures LogTape before `app.ts` loads (must
  happen first — `app.ts` emits logs at module load time)
- `node.ts` — Node entry point (HTTP/2, separate from the Deno path)
- `seconddeno.ts` — second server instance on `PORT + 1`, used to test
  advisory-lock / `lock_workflow_instance` behavior under concurrent access
- `env.ts` — Zod-validated environment config (`DB_TYPE`, `PORT`, `LOG_LEVEL*`,
  `OTEL_*`, etc.)
- `logger.ts` — composition-root LogTape configuration for this process
  (`configureApiLogger()`), via `@pgfsm/logging`
- `lib/create-app.ts` — app factory: its own pool (or `options.pool`),
  middleware (logging, request IDs, CORS, OTel tracing), API-key auth and the
  admin routes. Serves HTTP only: there's no embedded fsmlet (root `CLAUDE.md`
  #3; it stopped compiling after #341 and was removed in #472)
- `lib/create-router.ts` — `createRouter()`, kept apart from `create-app.ts`
  (which reads `env.ts` at import) so route modules import and test without the
  API's environment
- `lib/configure-open-api.ts` — OpenAPI/Scalar docs setup (available at `/docs`)
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
- `routes/fsm/` — core FSM operations: list, create, send (operator key)
- `routes/admin/` — `POST /admin/fsm/load`, `GET|POST /admin/keys`,
  `DELETE /admin/keys/{idOrName}` (admin key; mounted only with
  `--enable-admin-api`)
- `test/api-key-auth.test.ts` — auth, roles, rollback, admin routes, `createApp`
  startup checks
- `src/cli/index.ts` — CLI entry. SIGTERM/Ctrl-C drain in-flight requests
  (`server.shutdown()`), close the pool and exit 0; a second signal exits 130.
  Flags are copied into the env before `env.ts`/`logger.ts` load
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

Auth is **on by default**. Every `/fsm*` request needs
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
  `pgfsmctl db key create --name <n> --role admin` (as the schema owner). After
  that, keys are managed through `/admin/keys`
  (`pgfsmctl key create|list|revoke`).
