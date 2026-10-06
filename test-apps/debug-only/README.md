# debug-only

A pgfsm project, created by `@pgfsm/cli`.

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
