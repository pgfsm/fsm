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

The database needs fsm_core installed (the `fsm_core--<version>.sql` release
asset, or the PGXN extension), which also registers its pg_cron scheduler job.
Copy `.env.example` to `.env` (it's gitignored), here and in
`sync-worker/typescript/`. Every command below reads it from the directory it
runs in. Start them in this order, one terminal each:

```bash
npm run api          # the pgfsm API, with its admin routes (local)
npm run api:key      # once per database: prints the first admin key; put it in .env as PGFSM_API_KEY
npm run db:load      # every deploy: loads fsm/ through the API (before the sync worker)
npm run gateway      # Activity Gateway; async workers connect to it
cd sync-worker/typescript && deno task dev
cd async-worker/typescript && deno task start
cd async-worker/python && uv run run_async_worker.py start
cd async-worker/rust && cargo run --release -- start
cd async-worker/go && go run . start
```

## API keys

`npm run api:key` creates the first admin API key, as the database owner (once:
it's printed only then; only its hash is stored, and it refuses while an admin
key exists). More keys, and revoking them, go through the API:
`npx @pgfsm/ctl key create|list|revoke`. The scheduler's pg_cron job:
`npx @pgfsm/ctl scheduler status`.
