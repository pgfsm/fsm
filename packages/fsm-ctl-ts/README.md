# @pgfsm/ctl

`pgfsmctl` — operate a pgfsm deployment through its API
([`@pgfsm/api`](https://www.npmjs.com/package/@pgfsm/api)): load FSM
definitions, create, resume, send events to, stop and inspect FSM instances,
manage API keys, and check the scheduler's pg_cron job.

```bash
npx @pgfsm/ctl fsm load fsm               # every deploy, before sync workers start
npx @pgfsm/ctl instance create -n creditCheck -V v01
npx @pgfsm/ctl instance send -q <instance-uuid> -e APPROVE
npx @pgfsm/ctl scheduler status
```

pgfsmctl never connects to Postgres (SPEC-016): every command calls the API,
like `kubectl` and the Kubernetes API server. Point it at one with `--url` +
`--api-key`, `PGFSM_URL` + `PGFSM_API_KEY` (from the environment or a `.env` in
the current directory), or a named profile (`--profile <name>`, set up with
`pgfsmctl config set`). The URL includes the API's path prefix, e.g.
`http://localhost:9999/api/v1`. With none configured, a command exits `2`.

Installing fsm_core and the first admin key happen outside pgfsmctl, once per
database: the `fsm_core--<version>.sql` release asset (or the PGXN extension),
then `npx @pgfsm/api key bootstrap --db-url <owner url>`.

`-o table|json|ids` picks the output format; data goes to stdout and logs to
stderr, so `pgfsmctl … -o json | jq` gets clean JSON. Exit codes: `0` ok, `1`
error, `2` usage, `3` auth, `4` not found, `5` check failed, `130` interrupted.

To scaffold a project and add FSMs to it, use
[`@pgfsm/cli`](https://www.npmjs.com/package/@pgfsm/cli) (`pgfsm`). A project it
creates already pins this package as `npm run db:load`.

## Commands

| Command                                   | Key      | What it does                                                                                                                    |
| ----------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `fsm load <folder>`                       | admin    | Load every `<folder>/<fsmName>/<version>/fsm.json` in one transaction, children first; exit `1` and load nothing on any failure |
| `fsm list` / `fsm get <name>/<version>`   | operator | Loaded definitions with their digest, or one definition's fsm.json                                                              |
| `instance create -n <fsm> -V <version>`   | operator | Create an instance (`--input <json>` for the initial context) and enqueue it                                                    |
| `instance resume -q <id>`                 | operator | Re-enqueue an existing instance                                                                                                 |
| `instance send -q <id> -e <event>`        | operator | Send an event (`--event-data <json>` for its payload)                                                                           |
| `instance stop -q <id>`                   | operator | Stop the worker running the instance                                                                                            |
| `instance list [-n <fsm>] [--status <s>]` | operator | Instances, newest first, filtered in the database (`--limit`, default 50)                                                       |
| `instance get -q <id>`                    | operator | One instance: status, state, context, error                                                                                     |
| `key create\|list\|revoke`                | admin    | API keys                                                                                                                        |
| `scheduler status`                        | admin    | The `fsm_schedule_all_pending` pg_cron job; exit `5` if it isn't registered                                                     |
| `scheduler register [--schedule <s>]`     | admin    | (Re)register it, e.g. after `cron.unschedule` or to change the schedule (default `5 seconds`)                                   |
| `config set\|use\|list\|show`             | —        | Named targets (profiles); API keys kept in a separate `credentials.json` (mode `0600`)                                          |
| `completion bash\|zsh\|fish`              | —        | Print a shell completion script                                                                                                 |

Admin commands need an API running with `--enable-admin-api`.

`pgfsmctl --help` and `pgfsmctl <command> --help` list every option;
`pgfsmctl --version` prints the version. The full reference is
[docs/guides/CLI-USAGE.md](https://github.com/pgfsm/fsm/blob/main/packages/fsm-ctl-ts/docs/guides/CLI-USAGE.md).

## Before SPEC-016

`db cron register|unregister|status`, `db key create`, `scheduler run`,
`--db-url`, profiles' `db_url`/`db_password`/`tier` and `PGFSM_DB_URL` /
`PGFSM_TIER` are gone: installing fsm_core registers the pg_cron job
(`scheduler status|register` checks and re-registers it through the API), the
first admin key comes from `npx @pgfsm/api key bootstrap`, and a profile from
before keeps working by its `url` (the rest is dropped the next time it's set).

## Release

1. Bump `version` in `packages/fsm-ctl-ts/deno.json` in a PR. pgfsmctl calls the
   API, so a release that uses new API routes needs that `@pgfsm/api` released
   (and deployed) first.
2. After merge, tag `ctl-v<version>` on `main` and push it (at most three tags
   per push, see the root `CLAUDE.md`). `.github/workflows/npm-publish.yml`
   builds with `deno task build:npm` and publishes. It fails before building if
   the tag's version isn't `deno.json`'s or the commit isn't on `main`, and
   skips a version already on npm (#445).

## License

Apache-2.0
