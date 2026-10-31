# e2e

The load project for SPEC-007's acceptance suite (#458), created by `@pgfsm/cli`
like [`../debug-only/`](../debug-only/README.md). Its one FSM, `loadTest/v01`,
runs a `loadWork` actor in each language in parallel, then a `recordFinished`
action on the way to `Finished`. `loadWork` sleeps for its input's `workMs` and
returns which worker processed it (`worker` is the pod name in Kubernetes).

`tools/load.ts` drives two kinds of load:

- **Direct (`enqueue`)**: fills one language's actor queue, testing the activity
  tier alone (claim, gateway, workers, archive): throughput, loss, duplicates,
  connection counts. Messages name the system queue as their parent, so the
  gateway archives them without notifying an FSM instance, and each processed
  message leaves a row in `fsm_core.fsm_async_operation_queue_event_logs`.
- **Full cycle (`instances`)**: creates `loadTest` instances, through the sync
  worker, all four actors, back to each instance and its sync action. Needs the
  FSM loaded (`npm run db:load`), the pg_cron scheduler (`npm run db:pgcron`)
  and the sync worker running. Instances pass no per-instance input to their
  actors (`fsm.json` keeps no invoke `input` function), so they do no work.

```bash
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
deno run -A tools/load.ts enqueue --language go --count 200 --work-ms 500 --run-id run1
deno run -A tools/load.ts instances --count 50 --work-ms 200 --run-id run1
# per language: sent, queued, succeeded, failed, duplicates, redelivered, lost,
# succeeded per minute, per worker; instances: created, done, per status.
# --wait polls until everything of the run is done.
deno run -A tools/load.ts stats --run-id run1 --wait 300 [--json]
```

Throughput is bounded by the gateway's poll loop: it claims each actor's free
slots once per `--poll-interval-ms`, so use a short interval when measuring.

## Process-level E2E

`tools/spec007-process-e2e-test.ts` checks SPEC-007's acceptance criteria that
need real processes but no cluster. It starts the gateway CLI from repository
source on TCP with TLS and one token per language (`--auth-token-dir`), and the
four workers here as subprocesses connecting over `https://`. Then it checks:

- the core flow: every worker registers with its own token, and each language's
  load is processed exactly once;
- auth: a wrong or missing token gets `UNAUTHENTICATED` before registration,
  plaintext to the TLS listener fails, and a token added to or removed from the
  directory takes effect without a gateway restart;
- bounded connections: the gateway's Postgres backends stay within its pool at 1
  and 3 TypeScript workers, and the workers have no database settings at all;
- gateway restarts under load (SIGTERM, then SIGKILL): workers re-register
  without restarting, and no message is lost.

CI runs it in the end-to-end job. Locally it needs a migrated database,
`openssl`, `uv`, `cargo` and `go`; `E2E_LANGUAGES=typescript` skips the other
three:

```bash
cd tools
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  deno test --allow-all spec007-process-e2e-test.ts
```

The criteria that need a cluster (throughput scaling with replicas, a rolling
restart of the gateway Deployment, half-open connections) are the kind suite's.

`recordFinished` also let `@pgfsm/sync-worker` 0.4.0 and earlier serve
`loadTest` at all: they only served FSMs with at least one sync operation. From
0.4.1 (#497) the sync worker serves every FSM in `FSM_DEFINITIONS`, actor-only
ones too.

The source of `loadTest` is its `fsm.json` (`fsm/loadTest/v01/`,
`fsm/loadTest/v02/`). After editing one, regenerate it with the local CLI (from
this directory), e.g.
`deno run -A ../../packages/fsm-cli-ts/src/cli/pgfsm.ts add fsm/loadTest/v02/fsm.json --force`
(the stubs are kept).

`instances` creates loadTest **v02** instances (SPEC-013): their four invokes
share the input `loadWorkInput` (`sync-worker/typescript/loadTest/v02/inputs/`),
which gives each actor `{ n, runId, workMs }` from the instance's context, so
`--work-ms` sets the actors' work per instance. v01 is the same FSM without
input, kept because a loaded version can't change.

The rest of this README is what `pgfsm create` generates.

- `fsm/<name>/<version>/`: compiled FSM definitions (`fsm.json`).
- `sync-worker/typescript/`: actions, guards and delays.
- `async-worker/{typescript,python,rust,go}/`: actors, one project per language.

Stub files under the worker folders are yours to implement. Each action, guard,
delay and actor has its own, e.g.
`sync-worker/typescript/<name>/<version>/guards/<guard>/<guard>.ts`. Re-running
`add` never overwrites them, and creates a new stub for each operation an FSM
gains. Code shared by several operations can go in a sibling module such as
`guards/_shared.ts`.

## Add an FSM

```bash
npm run fsm:add -- path/to/machine.ts --fsm-name checkout --fsm-version v01
npm run fsm:add -- path/to/fsm.json
npm run fsm:add -- path/to/folder/   # <fsmName>/<vNN>/{machine.ts|fsm.json}
```

After editing a `machine.ts` or `fsm.json`, regenerate that FSM with the same
command plus `--force` (your stubs are kept):

```bash
npm run fsm:add -- path/to/machine.ts --fsm-name checkout --fsm-version v01 --force
```

A loaded FSM version is immutable: once `npm run db:load` has put it in a
database, changing its `fsm.json` means adding it again as a new version
(`--fsm-version v02`). The sync worker refuses to start while the database holds
a different definition than the one it was generated from.

## Run the stack

Copy `.env.example` to `.env` (it's gitignored), here and in
`sync-worker/typescript/`. Every command below reads `DATABASE_URL` from the
environment or from a `.env` in the directory it runs in; locally that's all you
need. Start them in this order, one terminal each:

```bash
npm run db:load      # every deploy: loads fsm/ into the database (before the sync worker)
npm run db:pgcron    # once per database: registers the pg_cron scheduler job
npm run gateway      # Activity Gateway; async workers connect to it
cd sync-worker/typescript && deno task dev
cd async-worker/typescript && deno task start
cd async-worker/python && uv run run_async_worker.py start
cd async-worker/rust && cargo run --release -- start
cd async-worker/go && go run . start
```

## With the pgfsm REST API

`npm run db:key` creates an admin API key straight in the database (once: it's
printed only then; only its hash is stored). Put it and the API's URL in `.env`
as `PGFSM_API_KEY` and `PGFSM_URL`: `npm run db:load` then loads through the API
instead of straight into the database. More keys, and revoking them, go through
the API: `npx @pgfsm/ctl key create|list|revoke`.
