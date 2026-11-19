# @pgfsm/api

The pgfsm REST API, `pgfsm-api`: FSM instances, loaded definitions, API keys and
the scheduler's pg_cron job over HTTP, in front of a database with fsm_core
installed. It plays the part PostgREST and GoTrue play for Supabase: services
and `pgfsmctl` talk to it, never to Postgres directly.

## Install

```bash
npx @pgfsm/api --help                       # Node
docker run ghcr.io/pgfsm/api:<version> --help  # image, amd64 and arm64
```

Kubernetes reference manifests: [`deploy/k8s`](deploy/k8s/README.md).

## Prerequisites

fsm_core installed in the database: the full install (`fsm_core--<version>.sql`)
or the PGXN extension, from the `fsm_core-v*` GitHub releases (see
`packages/database-src/README.md`). The API checks `fsm_core.version()` at
startup and refuses an fsm_core it doesn't support, naming the upgrade scripts
to apply.

## Usage

```bash
# Once, after installing fsm_core: the first admin API key, as the database
# owner (the login that ran the install). Prints only the key, once.
npx @pgfsm/api key bootstrap --db-url postgres://owner:…@db/postgres

# Serve /api/v1, logging in as fsm_authenticator (set its password first)
npx @pgfsm/api --db-url postgres://fsm_authenticator:…@db/postgres

# The internal admin deployment also serves /api/v1/admin/*
npx @pgfsm/api --enable-admin-api --db-url postgres://fsm_authenticator_admin:…@db/postgres
```

`key bootstrap` refuses while an admin key exists; pass `--force` to create
another (e.g. to recover). After that, manage keys through the admin API:
`pgfsmctl key create|list|revoke`.

| Route                                      | Key      | What                                                         |
| ------------------------------------------ | -------- | ------------------------------------------------------------ |
| `GET/POST /instances`, `/instances/{id}/…` | operator | create, read, send events to, resume and stop instances      |
| `GET /definitions…`                        | operator | the loaded FSM definitions                                   |
| `POST /admin/definitions`                  | admin    | load FSM definitions (`pgfsmctl fsm load`)                   |
| `GET/POST /admin/keys`, `DELETE …/{id}`    | admin    | API keys                                                     |
| `GET/POST /admin/scheduler`                | admin    | the pg_cron job: status, and (re)register (`{ "schedule" }`) |

OpenAPI: `/api/v1/openapi` (JSON) and `/api/v1/docs` (Scalar).

Configuration comes from flags or the environment (`DATABASE_URL`, `PORT`,
`PGFSM_ENABLE_ADMIN_API`, `PGFSM_NO_AUTH`, `LOG_LEVEL`, `OTEL_*`); the CLI reads
`./.env` if present (`--env-file` for another).

## License

Apache-2.0
