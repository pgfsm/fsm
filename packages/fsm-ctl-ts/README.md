# @pgfsm/ctl

`pgfsmctl` — operate a pgfsm database: register the pg_cron scheduler job, and
create, resume, send events to, or stop FSM instances.

```bash
npx @pgfsm/ctl pgcron register            # once per database, after migrations
npx @pgfsm/ctl instance create -n creditCheck -V v01
npx @pgfsm/ctl instance send -q <instance-uuid> -e APPROVE
```

Every command takes `-d/--db-url <url>`, or reads `DATABASE_URL` from the
environment or a `.env` in the current directory. None of them needs a pgfsm
project — only a database — so the same command works on a laptop, in CI, or as
a Kubernetes Job.

To scaffold a project and add FSMs to it, use
[`@pgfsm/cli`](https://www.npmjs.com/package/@pgfsm/cli) (`pgfsm`). A project it
creates already pins this package as `npm run db:pgcron`.

## Commands

| Command                                 | What it does                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pgcron register [-s <cron>]`           | (Re)register the `fsm_schedule_all_pending` pg_cron job (default schedule `"5 seconds"`). Idempotent |
| `pgcron unregister`                     | Remove the job; succeeds if it isn't registered                                                      |
| `pgcron status`                         | Print the registered job; exit `1` if none                                                           |
| `instance create -n <fsm> -V <version>` | Create an instance (`--context <json>` for the initial context) and enqueue it                       |
| `instance resume -q <id>`               | Re-enqueue an existing instance                                                                      |
| `instance send -q <id> -e <event>`      | Send an event (`--event-data <json>` for its payload)                                                |
| `instance stop -q <id>`                 | Stop the worker running the instance                                                                 |
| `scheduler run`                         | Standing scheduler process — a fallback only; the pg_cron job is the primary scheduler               |

`pgfsmctl --help` and `pgfsmctl <command> --help` list every option;
`pgfsmctl --version` prints the version. The full reference is
[docs/guides/CLI-USAGE.md](https://github.com/pgfsm/fsm/blob/main/packages/fsm-ctl-ts/docs/guides/CLI-USAGE.md).

## Migrating from `@pgfsm/sync-worker` ≤ 0.2

`@pgfsm/sync-worker` 0.3 ships no bins. The old ones map to:

| Before (`npx -p @pgfsm/sync-worker -- …`) | Now (`npx @pgfsm/ctl …`)                |
| ----------------------------------------- | --------------------------------------- |
| `pgcron [-s <cron>]`                      | `pgcron register [-s <cron>]`           |
| `fsmctl -c create -n <fsm> -V <v>`        | `instance create -n <fsm> -V <v>`       |
| `fsmctl -c resume\|send\|stop -q <id> …`  | `instance resume\|send\|stop -q <id> …` |
| `fsmscheduler [-p <ms>] [-s <secs>]`      | `scheduler run [-p <ms>] [-s <secs>]`   |

Flags are unchanged apart from `-c/--command`, which is now the verb.
`runFsmScheduler` (and `FsmSchedulerOptions`, `scheduleNextPending`,
`SCHEDULER_NOTIFY_CHANNEL`) moved from `@pgfsm/sync-worker` to `@pgfsm/ctl`.

## Release

1. Bump `version` in `packages/fsm-ctl-ts/deno.json` in a PR. If this release
   needs new `@pgfsm/db` exports, release `@pgfsm/db` first: the npm build pins
   `@pgfsm/db` to `^<its deno.json version>`.
2. After merge, tag `ctl-v<version>` on `main` and push it (at most three tags
   per push, see the root `CLAUDE.md`). `.github/workflows/npm-publish.yml`
   builds with `deno task build:npm` and publishes.

## License

Apache-2.0
