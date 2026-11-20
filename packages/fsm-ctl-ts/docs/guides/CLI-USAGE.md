# pgfsmctl — CLI Usage Guide

`@pgfsm/ctl` ships one bin, `pgfsmctl`, for operating a pgfsm deployment
(SPEC-005, conventions from SPEC-009). Commands are `<noun> <verb>`. pgfsmctl is
an API client only (SPEC-016): every command calls the pgfsm API
([`@pgfsm/api`](../../../fsm-api-ts/README.md)) with an API key, and none opens
a Postgres connection, the way `kubectl` talks only to the Kubernetes API
server. `config`, `completion` and `version` are local.

| Command                                                    | Key      | Role                                                                        |
| ---------------------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| `fsm load <folder>`                                        | admin    | Load FSM definitions (`fsm.json`): a deploy step (SPEC-006)                 |
| `fsm list \| get`                                          | operator | Loaded definitions and their digests, or one definition's fsm.json          |
| `instance create \| resume \| send \| stop \| list \| get` | operator | Instance control (kubectl equivalent) against the dispatch-queue model      |
| `key create \| list \| revoke`                             | admin    | API keys                                                                    |
| `scheduler status \| register`                             | admin    | The `fsm_schedule_all_pending` pg_cron job, which drains the dispatch queue |
| `config set \| use \| list \| show`                        | local    | Named targets (profiles): API URLs, keys kept apart                         |
| `completion bash \| zsh \| fish`                           | local    | Print a shell completion script                                             |
| `version`                                                  | local    | Print the version (`-o json` for `{ "version": … }`)                        |

No command needs a pgfsm project (`pgfsm.config.json`). Admin commands need an
API started with `--enable-admin-api`.

Two steps happen outside pgfsmctl, once per database, because no API key can
exist before them:

1. **Install fsm_core**: the `fsm_core--<version>.sql` release asset (or the
   PGXN extension), as the database owner. It also registers the pg_cron job
   (see `packages/database-src/README.md`).
2. **The first admin key**: `npx @pgfsm/api key bootstrap --db-url <owner url>`,
   which prints it once.

> **`fsmlet`** (the kubelet-equivalent node agent) is not a `pgfsmctl` command:
> it runs your sync-operation code, so a project embeds it —
> `sync-worker/typescript/run-sync-worker.ts` calls `runFsmlet` from
> `@pgfsm/sync-worker`.

---

## Prerequisites and invocation

- **Installed** (Node): `npx @pgfsm/ctl <noun> <verb> [options]` — the package
  has a single bin, so no `-p … --` form is needed. A pgfsm project pins it as
  `npm run db:load`.
- **From this repo** (Deno, see `.prototools`): from `packages/fsm-ctl-ts/`,
  `deno task pgfsmctl <noun> <verb> [options]`; or from the repo root,
  `deno run --allow-all packages/fsm-ctl-ts/src/cli/pgfsmctl.ts …`.

Examples below use `pgfsmctl` for whichever of these you use.
`pgfsmctl --version` (or `pgfsmctl version`) prints the bare version;
`pgfsmctl --help` and `pgfsmctl <noun> --help` print usage. Unknown options are
an error (exit `2`), not ignored.

### Which API

The URL and the key are resolved separately, first match wins:

1. `--url` / `--api-key`
2. a profile chosen explicitly (`--profile`, else `$PGFSM_PROFILE`): its `url`
   and `api_key`. An explicit profile **replaces** the environment and the
   current profile, so a stray `$PGFSM_URL` can't override it.
3. `$PGFSM_URL` / `$PGFSM_API_KEY` (a `.env` in the current directory is read)
4. the current profile's `url` / `api_key` (`pgfsmctl config use <name>`)

The URL is the API's base **including its path prefix**, e.g.
`http://localhost:9999/api/v1` for an API started with the default `/api/v1`.
With no URL, a command exits `2` naming these options; a URL without a key exits
`2` too. Store a key with
`echo "$KEY" | pgfsmctl config set <profile> --api-key-stdin`. Run with
`PGFSMCTL_LOG_LEVEL=debug` to see which source was used. A `DATABASE_URL` in the
environment or `./.env` is never used.

### Output

`-o/--output table|json|ids` (default `table`). Data goes to **stdout**, logs to
**stderr**, so `pgfsmctl … -o json | jq` and
`ID=$(pgfsmctl instance create … -o ids)` always get clean data. `json` is never
truncated; `ids` prints one identifier per line (`<fsmName>/<version>` for
`fsm`, the instance UUID for `instance`, the key's id for `key`, the job name
for `scheduler`, the profile name for `config`).

---

## `fsm load` — FSM definitions

```bash
pgfsmctl fsm load <folder>   # e.g. `fsm` in a pgfsm project
```

Loads every `<folder>/<fsmName>/<version>/fsm.json` (version folders are `v01`,
`v02`, …) into `fsm_core.fsm_json` and the state/transition tables, as one batch
(SPEC-006), through the API's `POST /admin/definitions` with an admin key:

1. **Validated before anything is written.** A child FSM that a definition
   invokes (`asyncOperationType: "fsm"`) must be in the folder or already
   loaded, and the batch must have no dependency cycle.
2. **Children first.** A definition is loaded after every child FSM it invokes,
   whatever order the folders sort in.
3. **One transaction.** Any failure rolls back the whole batch; the command
   prints every problem and exits `1` (`3` if the key was rejected).

Re-running it is safe: a definition already loaded with identical content is
reported `unchanged`. A definition is immutable per version, so changed content
under a loaded version is refused; give the changed `fsm.json` a new version.
Concurrent runs are serialized per name/version in the database. A missing
folder, or one with no `fsm.json`, exits `2`.

Run it on every deploy, after installing or upgrading fsm_core and **before**
starting sync workers: a worker refuses to start while an FSM version it serves
is missing from the database, or differs from the `fsm.json` it was compiled
from. It replaces `@pgfsm/compiler`'s deprecated `-c load`.

| Flag               | Alias | Description                                     |
| ------------------ | ----- | ----------------------------------------------- |
| `--url <url>`      |       | API base URL (see [Which API](#which-api))      |
| `--api-key <key>`  |       | Admin key                                       |
| `--profile <name>` |       | Use this profile's `url` and `api_key`          |
| `--output <fmt>`   | `-o`  | `table` (FSM, version, status), `json` or `ids` |
| `--help`           | `-h`  | Print help and exit                             |

### `fsm list` and `fsm get` — loaded definitions (#661)

```bash
pgfsmctl fsm list                        # every loaded name/version and its digest
pgfsmctl fsm list -n creditCheck -o ids  # creditCheck/v01, creditCheck/v02, …
pgfsmctl fsm get creditCheck/v02 -o json # the stored fsm.json
```

`list` shows each version's SHA-256 digest, the one sync workers' startup check
compares against the fsm.json they were compiled from (SPEC-006). `get` exits
**`4`** when that version isn't loaded. Both need only an **operator** key;
loading stays admin-only.

---

## `key` — API keys

```bash
export PGFSM_URL=http://localhost:9999/api/v1 PGFSM_API_KEY=pgfsm_admin_…
pgfsmctl key create --name ci --role operator
pgfsmctl key list
pgfsmctl key revoke ci
```

Keys are `pgfsm_admin_…` or `pgfsm_op_…`. Only their SHA-256 and a display
prefix are stored, so **`create` prints the key once** (and warns on stderr).
`key list` never shows a key, only its prefix, role, last use and revocation.
The first admin key comes from `npx @pgfsm/api key bootstrap`, the way a
Supabase project's keys are minted outside its API.

| Exit | When                                                                          |
| ---- | ----------------------------------------------------------------------------- |
| `2`  | Missing `--name`/`--role`, an unknown role, no API target, a URL with no key  |
| `3`  | The key was rejected: unknown or revoked (`401`), or not an admin key (`403`) |
| `4`  | `revoke` matched no live key, or `/admin/*` doesn't exist (admin API off)     |
| `1`  | A duplicate key name (`409`), or the API is unreachable                       |

| Flag                 | Alias | Description                             |
| -------------------- | ----- | --------------------------------------- |
| `--name <name>`      |       | Key name, unique (`create`)             |
| `--role <role>`      |       | `admin` or `operator` (`create`)        |
| `--url`, `--api-key` |       | API target                              |
| `--profile <name>`   |       | Use this profile                        |
| `--output <fmt>`     | `-o`  | `table`, `json` or `ids` (the key's id) |

---

## `instance` — FSM instance control

```bash
pgfsmctl instance create -n creditCheck -V v01
pgfsmctl instance create -n creditCheck -V v01 --input '{"userId":"abc"}'
pgfsmctl instance resume -q <instance-uuid>
pgfsmctl instance send   -q <instance-uuid> -e APPROVE --event-data '{"reason":"ok"}'
pgfsmctl instance stop   -q <instance-uuid>
pgfsmctl instance list   -n creditCheck --status error     # newest first, at most 50
pgfsmctl instance get    -q <instance-uuid> -o json

ID=$(pgfsmctl instance create -n creditCheck -V v01 -o ids)
```

| Verb     | What it does                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| `create` | Creates the instance and its pgmq queue, sends the initial transition event, and enqueues it to `fsm_dispatch_queue`  |
| `resume` | Re-enqueues an existing instance to `fsm_dispatch_queue`                                                              |
| `send`   | Sends an event to the instance's queue, with event logs                                                               |
| `stop`   | Sends a stop signal to the fsmlet worker running the instance, via `pg_notify`                                        |
| `list`   | Instances, newest first, filtered in the database (#661): `id`, FSM, version, status, state, started at               |
| `get`    | One instance: status, state, context, error (SPEC-014's record), parent, times; `-o json` adds the full row and state |

They call `POST /instances`, `POST /instances/<id>/resume`, `/events` or
`/stop`, `GET /instances` and `GET /instances/<id>` (#660, #661, #675) with an
**operator** key (an admin key works too). `resume`, `send`, `stop` and `get`
exit **`4`** when the instance doesn't exist; `3` for a rejected key.

| Flag            | Alias | Required by                     | Description                                                   |
| --------------- | ----- | ------------------------------- | ------------------------------------------------------------- |
| `--fsm-name`    | `-n`  | `create`; filter (`list`)       | FSM definition name                                           |
| `--fsm-version` | `-V`  | `create`; filter (`list`)       | FSM version                                                   |
| `--status`      |       | filter (`list`)                 | `active`, `done`, `error` or `stopped`                        |
| `--limit`       |       | optional (`list`)               | At most this many, newest first: 1 to 1000, default 50        |
| `--input`       |       | optional (`create`)             | Initial FSM context, JSON (xstate's `input`; was `--context`) |
| `--queue-name`  | `-q`  | `resume`, `send`, `stop`, `get` | FSM instance ID (a UUID; anything else exits `2`)             |
| `--event-type`  | `-e`  | `send`                          | Event type to send                                            |
| `--event-data`  |       | optional (`send`)               | Event payload, JSON                                           |
| `--url`         |       | optional                        | API base URL incl. its path prefix                            |
| `--api-key`     |       | optional                        | Operator (or admin) key                                       |
| `--profile`     |       | optional                        | Use this profile's `url` and `api_key`                        |
| `--output`      | `-o`  | optional                        | `table`, `json` or `ids` (the instance UUID)                  |
| `--help`        | `-h`  |                                 | Print help and exit                                           |

---

## `scheduler` — the pg_cron job

```bash
pgfsmctl scheduler status                          # exit 5 if it isn't registered
pgfsmctl scheduler register                        # default schedule: "5 seconds"
pgfsmctl scheduler register --schedule '10 seconds'
```

The `fsm_schedule_all_pending` pg_cron job calls
`fsm_core.schedule_all_pending()` to drain `fsm_dispatch_queue` (SPEC-003).
Installing fsm_core (the full install, the migration chain from the 1.2.0
baseline, or `CREATE EXTENSION`) registers it, so a working deployment needs no
step here. `status` prints the job (registered, schedule, active, command) and
exits **`5`** when it isn't registered, so it doubles as a deploy check.
`register` idempotently (re)registers it, replacing any existing job: after a
`cron.unschedule`, or to change the schedule.

Both call `GET/POST /admin/scheduler` with an admin key. The API runs them
through `SECURITY DEFINER` functions granted to `fsm_admin`, so the job always
belongs to the schema owner and the API never logs in as it. pgfsmctl's old
`scheduler run` fallback process and `db cron` commands are gone (SPEC-016):
pg_cron is required.

| Flag                 | Alias | Description                                                      |
| -------------------- | ----- | ---------------------------------------------------------------- |
| `--schedule <s>`     |       | `register`: pg_cron schedule, e.g. `10 seconds` or `*/1 * * * *` |
| `--url`, `--api-key` |       | API target                                                       |
| `--profile <name>`   |       | Use this profile                                                 |
| `--output <fmt>`     | `-o`  | `table`, `json` or `ids` (the job name)                          |
| `--help`             | `-h`  | Print help and exit                                              |

---

## `config` — profiles

```bash
echo "$PGFSM_API_KEY" | pgfsmctl config set prod \
    --url https://pgfsm-api.internal/api/v1 --api-key-stdin --use
pgfsmctl config set staging --url https://pgfsm-api.staging/api/v1
pgfsmctl config use prod
pgfsmctl config list
pgfsmctl config show prod -o json
```

| Verb   | What it does                                                                            |
| ------ | --------------------------------------------------------------------------------------- |
| `set`  | Create or update a profile; only the given fields change. The first one becomes current |
| `use`  | Make a profile the current one (exit `4` if it doesn't exist)                           |
| `list` | Every profile; `*` marks the current one                                                |
| `show` | One profile (default: the current one); the key shows only as `set`                     |

Files live in `$PGFSM_CONFIG_DIR`, else the OS config directory plus `pgfsm`
(`$XDG_CONFIG_HOME` or `~/.config` on Linux, `~/Library/Application Support` on
macOS, `%APPDATA%` on Windows):

- `config.yaml`: profiles (`url`) and `current`. **No secrets.**
- `credentials.json`: per-profile `api_key`, mode `0600`.

The key is read from stdin (`--api-key-stdin`), never from arguments, so it
stays out of shell history. Profiles written before SPEC-016 keep working by
their `url`; their `db_url`, `tier` and `db_password` are ignored and dropped
the next time the profile is set.

---

## `completion`

```bash
source <(pgfsmctl completion bash)                       # ~/.bashrc
source <(pgfsmctl completion zsh)                        # ~/.zshrc
pgfsmctl completion fish > ~/.config/fish/completions/pgfsmctl.fish
```

Completes nouns, verbs and each noun's flags.

---

## HTTP API equivalents

The API server (`packages/fsm-api-ts`) serves these resources under its path
prefix (`--url-path-prefix`, default `/api/v1`; #675). They need an operator or
admin key (`Authorization: Bearer pgfsm_…`, SPEC-009 §3), `/admin/*` an admin
key on an API started with `--enable-admin-api`, unless the server runs with
`--no-auth`:

| HTTP route                                              | `pgfsmctl` equivalent        | Body / response                                                                |
| ------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------ |
| `GET /instances?fsm_name=&fsm_version=&status=&limit=`  | `instance list`              | Newest first, filtered in the database; `limit` 1–1000, default 50             |
| `GET /instances/{id}`                                   | `instance get`               | `{ fsm_instance_row, resolved_state_value }`; 404 if unknown                   |
| `GET /definitions?fsm_name=&fsm_version=`               | `fsm list`                   | Loaded definitions with their SHA-256 digest (operator key, #661)              |
| `GET /definitions/{fsmName}`                            |                              | That FSM's loaded versions; 404 if none                                        |
| `GET /definitions/{fsmName}/versions/{fsmVersion}`      | `fsm get <name>/<version>`   | `{ fsm_name, fsm_version, fsm_json }`; 404 if not loaded                       |
| `POST /instances`                                       | `instance create`            | `{ fsm_name, fsm_version, input? }`: creates it and enqueues it for scheduling |
| `POST /instances/{id}/events`                           | `instance send`              | `{ type, ...payload }`; 404 if unknown                                         |
| `POST /instances/{id}/resume`                           | `instance resume`            | none; 404 if unknown                                                           |
| `POST /instances/{id}/stop`                             | `instance stop`              | none; 404 if unknown                                                           |
| `POST /admin/definitions`                               | `fsm load`                   | `{ definitions: [{ fsmName, fsmVersion, fsmJson }] }`                          |
| `GET/POST /admin/keys`, `DELETE /admin/keys/{idOrName}` | `key list\|create\|revoke`   | API keys                                                                       |
| `GET/POST /admin/scheduler`                             | `scheduler status\|register` | The pg_cron job; POST takes an optional `{ schedule }`, 422 if pg_cron rejects |

All of them need the pg_cron job and a running fsmlet to pick the work up.

---

## Exit codes

SPEC-009 §6 (dbosctl's table, plus `5`):

| Code  | Meaning                                                                                    |
| ----- | ------------------------------------------------------------------------------------------ |
| `0`   | Success                                                                                    |
| `1`   | General error: API unreachable, an `fsm load` the API rejected, anything unexpected        |
| `2`   | Usage: unknown noun/verb/option, missing or invalid arguments, bad `-o`, no API configured |
| `3`   | Authentication or authorization failed (HTTP `401`/`403`)                                  |
| `4`   | Not found: unknown instance, definition, profile or key (HTTP `404`)                       |
| `5`   | Check failed: a status command ran and found a problem (`scheduler status` with no job)    |
| `130` | Interrupted (`Ctrl+C`)                                                                     |
