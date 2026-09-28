# debug-only

A pgfsm project created by `@pgfsm/cli` (run from source), for debugging and
testing the platform. Unlike a user's project, its workers run against the SDK
**source in this repo**, not the published packages, so unreleased SDK,
sync-worker and CLI changes can be exercised without publishing anything.

- `fsm/<name>/<version>/`: compiled FSM definitions, from
  `apps/fsm-core-example/fsm/`.
- `sync-worker/typescript/`: actions, guards and delays.
- `async-worker/{typescript,python,rust,go}/`: actors, one project per language.

Created with (from the repo root):

```bash
deno run --allow-all packages/fsm-cli-ts/src/cli/pgfsm.ts create test-apps/debug-only apps/fsm-core-example/fsm
```

`sharedAsyncOperation/` (the `create-async-logic` pool) is not part of this
project: the CLI doesn't generate it (#405).

## Local-SDK overrides

Hand-edited after `create`. These live only here; they are deliberately not a
CLI flag, so users never see them. Each sits in a file `add` never rewrites, so
regenerating an FSM keeps them.

| Worker                    | File             | Override                                                                    |
| ------------------------- | ---------------- | --------------------------------------------------------------------------- |
| `sync-worker/typescript`  | `deno.json`      | `@pgfsm/sync-worker`, `@pgfsm/logging` → `packages/*/src/index.ts`          |
| `async-worker/typescript` | `deno.json`      | `@pgfsm/async-worker-sdk`, `@pgfsm/logging` → `packages/*/src/index.ts`     |
| `async-worker/python`     | `pyproject.toml` | `[tool.uv.sources]` editable path to `packages/fsm-async-worker-sdk-python` |
| `async-worker/rust`       | `Cargo.toml`     | `[patch.crates-io]` path to `packages/fsm-async-worker-sdk-rust`            |
| `async-worker/go`         | `go.work`        | `replace` to `packages/fsm-async-worker-sdk-go`                             |

Go uses `go.work` rather than a `replace` in `go.mod` because `go.mod` is
compiler-owned and rewritten by `add`. If you recreate this project, re-apply
the table above. After changing Python dependencies, run `uv sync` in
`async-worker/python/` and commit `uv.lock`.

## Add or regenerate an FSM

`npm run fsm:add` runs the CLI from source (`packages/fsm-cli-ts/`), not the
published package:

```bash
npm run fsm:add -- ../../apps/fsm-core-example/fsm/creditCheck/v01/fsm.json -N creditCheck -V v01
```

After editing a `machine.ts` or `fsm.json`, regenerate that FSM with the same
command plus `--force` (stubs and the overrides above are kept).

## Run the workers

```bash
cd sync-worker/typescript && deno task dev
cd async-worker/typescript && deno task start
cd async-worker/python && uv run run_async_worker.py start
cd async-worker/rust && cargo run --release -- start
cd async-worker/go && go run . start
```

Replace `start` with `list` to print an async worker's registry without
connecting. The sync worker and `start` need local Supabase and the Activity
Gateway running; see the root `DEVELOPER.md`.
