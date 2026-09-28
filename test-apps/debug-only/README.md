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

## Run the workers

```bash
cd sync-worker/typescript && deno task dev
cd async-worker/typescript && deno task start
cd async-worker/python && uv run run_async_worker.py start
cd async-worker/rust && cargo run --release -- start
cd async-worker/go && go run . start
```
