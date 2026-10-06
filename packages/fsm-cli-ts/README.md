# @pgfsm/cli

Create a pgfsm worker project from your FSM definitions, then keep adding FSMs
to it — all through `npx`, with nothing added to the project's own dependencies.

```bash
npx @pgfsm/cli create my-app ./fsm                                   # a folder of <fsmName>/<vNN>/
npx @pgfsm/cli create my-app ./checkout.json -N checkout -V v01      # one fsm.json
npx @pgfsm/cli create my-app ./machine.ts -N checkout -V v01         # one XState machine.ts
npx @pgfsm/cli create my-app                                         # empty; add FSMs later

cd my-app
npx @pgfsm/cli add ../designs/payment/machine.ts -N payment -V v01
npx @pgfsm/cli add ../designs/payment/machine.ts -N payment -V v01 --force   # after editing it
```

`create` makes one directory holding everything:

```
my-app/
├── pgfsm.config.json       # project marker: { name, toolVersion }
├── package.json            # scripts only, pinned via npx: fsm:add, db:load, db:pgcron, db:key, gateway
├── .env.example            # DATABASE_URL for local dev; PGFSM_URL/PGFSM_API_KEY to load via the API
├── deno.json               # maps xstate, so machine.ts files compile
├── fsm/<name>/<vNN>/       # compiled fsm.json (+ xstate-fsm.json)
├── sync-worker/typescript/ # actions, guards, delays — a runnable Deno project
└── async-worker/
    ├── typescript/         # actors, one runnable project per language —
    ├── python/             # all four are created up front, empty until an
    ├── rust/               # FSM uses that language
    └── go/
```

## Commands

| Command                   | What it does                                                                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create <dir> [<source>]` | Run from the parent directory. Refuses a directory that is (or is inside) a pgfsm project, or isn't empty. `--name` sets the project name (default: the directory name).                                                                 |
| `add <source>`            | Run from anywhere inside the project — it walks up to `pgfsm.config.json`, and prints which project it used. Refuses an existing `fsm/<name>/<vNN>/` unless `--force`, which is also how you regenerate an FSM after editing its source. |

`<source>` is a folder (`<fsmName>/<vNN>/machine.ts` or `fsm.json` inside it), a
single `fsm.json`, or a single `machine.ts`. For a single file, the FSM name and
version come from `-N`/`--fsm-name` and `-V`/`--fsm-version`, or from the file's
own `<fsmName>/<vNN>/` folders; otherwise you're asked (or, with `--no-input` or
outside a terminal, told which flag to pass). They're never guessed from an
arbitrary path.

Common options: `--dry-run` shows the plan without writing anything, `-C <dir>`
uses a specific project instead of searching upward, `--verbose` shows the
compiler's own progress.

## Your code is never overwritten

Stub files — actions, guards, delays, actors — and each worker's entry file and
`deno.json`/`pyproject.toml`/`Cargo.toml` are yours once created. `add` (with or
without `--force`) only rewrites compiler-owned files (registries, manifests,
`fsm.json`, the Go worker module). When an FSM gains an action your existing
stub file doesn't define, the output lists the names to add.

Every run ends with a summary per area: `+` created, `~` regenerated, `=` kept.

That includes `sync-worker/typescript/run-sync-worker.ts`. Projects created
before `FSM_DEFINITIONS` existed keep a version that doesn't pass it to
`runFsmlet`, which `@pgfsm/sync-worker` 0.3 requires: the worker refuses to
start until you import `FSM_DEFINITIONS` next to `SYNC_OPERATION_REGISTRATIONS`
and pass it as `runFsmlet`'s third argument, after
`SYNC_OPERATION_REGISTRATIONS`.

## Requirements

- Node.js ≥ 22.18 (for `machine.ts` sources: TypeScript is loaded natively), or
  Deno: `deno run -A npm:@pgfsm/cli ...`.
- The worker toolchains you want to run: Deno, uv, cargo, go. If `go` is
  installed, `go mod tidy` runs for you so the Go worker builds straight away.

`machine.ts` is compiled where it lives and never copied into the project. Under
Node, its `xstate` import resolves on its own; for other packages it imports,
add a `deno.json` next to it mapping them.
