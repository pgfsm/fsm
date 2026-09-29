# debug-only

A pgfsm project, created by `@pgfsm/cli`.

- `fsm/<name>/<version>/`: compiled FSM definitions (`fsm.json`).
- `sync-worker/typescript/`: actions, guards and delays.
- `async-worker/{typescript,python,rust,go}/`: actors, one project per language.

Stub files under the worker folders are yours to implement. Re-running `add`
never overwrites them.

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

Every command below reads `DATABASE_URL` from the environment or from a `.env`
in the directory it runs in. Start them in this order, one terminal each:

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
