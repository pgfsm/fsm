# @pgfsm/ctl

`pgfsmctl` — operate a pgfsm database: load FSM definitions, register the
pg_cron scheduler job, and create, resume, send events to, or stop FSM
instances.

```bash
npx @pgfsm/ctl fsm load fsm               # every deploy, before sync workers start
npx @pgfsm/ctl db cron register           # once per database, after migrations
npx @pgfsm/ctl instance create -n creditCheck -V v01
npx @pgfsm/ctl instance send -q <instance-uuid> -e APPROVE
```

Database commands take `-d/--db-url <url>`, a named profile (`--profile <name>`,
set up with `pgfsmctl config set`), or `PGFSM_DB_URL` / `DATABASE_URL` from the
environment or a `.env` in the current directory. None of them needs a pgfsm
project — only a database — so the same command works on a laptop, in CI, or as
a Kubernetes Job.

`-o table|json|ids` picks the output format; data goes to stdout and logs to
stderr, so `pgfsmctl … -o json | jq` gets clean JSON. Exit codes: `0` ok, `1`
error, `2` usage, `3` auth, `4` not found, `5` check failed, `130` interrupted.

To scaffold a project and add FSMs to it, use
[`@pgfsm/cli`](https://www.npmjs.com/package/@pgfsm/cli) (`pgfsm`). A project it
creates already pins this package as `npm run db:load` and `npm run db:pgcron`.

## Commands

| Command                                           | What it does                                                                                                                                                                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fsm load <folder>`                               | Load every `<folder>/<fsmName>/<version>/fsm.json` in one transaction, children first; through the API when one is configured (admin key), else DB-direct; `--db-url` forces DB-direct. Exit `1` and load nothing on any failure |
| `db cron register [-s <cron>]`                    | (Re)register the `fsm_schedule_all_pending` pg_cron job (default schedule `"5 seconds"`). Idempotent                                                                                                                             |
| `db cron unregister`                              | Remove the job; succeeds if it isn't registered                                                                                                                                                                                  |
| `db cron status`                                  | Print the registered job; exit `5` if none                                                                                                                                                                                       |
| `db key create --name <n> --role admin\|operator` | Mint an API key in the database (the bootstrap admin key); printed once                                                                                                                                                          |
| `key create\|list\|revoke`                        | Manage API keys through the REST API with an admin key (`--url`/`PGFSM_URL` + `--api-key`/`PGFSM_API_KEY`)                                                                                                                       |
| `instance create -n <fsm> -V <version>`           | Create an instance (`--input <json>` for the initial context) and enqueue it                                                                                                                                                     |
| `instance resume -q <id>`                         | Re-enqueue an existing instance                                                                                                                                                                                                  |
| `instance send -q <id> -e <event>`                | Send an event (`--event-data <json>` for its payload)                                                                                                                                                                            |
| `instance stop -q <id>`                           | Stop the worker running the instance                                                                                                                                                                                             |
| `scheduler run`                                   | Standing scheduler process — a fallback only; the pg_cron job is the primary scheduler                                                                                                                                           |
| `config set\|use\|list\|show`                     | Named targets (profiles); passwords and API keys kept in a separate `credentials.json` (mode `0600`)                                                                                                                             |
| `completion bash\|zsh\|fish`                      | Print a shell completion script                                                                                                                                                                                                  |

`pgfsmctl --help` and `pgfsmctl <command> --help` list every option;
`pgfsmctl --version` prints the version. The full reference is
[docs/guides/CLI-USAGE.md](https://github.com/pgfsm/fsm/blob/main/packages/fsm-ctl-ts/docs/guides/CLI-USAGE.md).

## Migrating from `@pgfsm/sync-worker` ≤ 0.2

`@pgfsm/sync-worker` 0.3 ships no bins. The old ones map to:

| Before (`npx -p @pgfsm/sync-worker -- …`) | Now (`npx @pgfsm/ctl …`)                |
| ----------------------------------------- | --------------------------------------- |
| `pgcron [-s <cron>]`                      | `db cron register [-s <cron>]`          |
| `fsmctl -c create -n <fsm> -V <v>`        | `instance create -n <fsm> -V <v>`       |
| `fsmctl -c resume\|send\|stop -q <id> …`  | `instance resume\|send\|stop -q <id> …` |
| `fsmscheduler [-p <ms>] [-s <secs>]`      | `scheduler run [-p <ms>] [-s <secs>]`   |

Flags are unchanged apart from `-c/--command`, which is now the verb, and
`--context`, which is now `--input`. `runFsmScheduler` (and
`FsmSchedulerOptions`, `scheduleNextPending`, `SCHEDULER_NOTIFY_CHANNEL`) moved
from `@pgfsm/sync-worker` to `@pgfsm/ctl`.

## Release

1. Bump `version` in `packages/fsm-ctl-ts/deno.json` in a PR. If this release
   needs new `@pgfsm/db` exports, release `@pgfsm/db` first: the npm build pins
   `@pgfsm/db` to `^<its deno.json version>`.
2. After merge, tag `ctl-v<version>` on `main` and push it (at most three tags
   per push, see the root `CLAUDE.md`). `.github/workflows/npm-publish.yml`
   builds with `deno task build:npm` and publishes.

## License

Apache-2.0
