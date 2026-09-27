# SPEC-004: `@pgfsm/cli` — npx `create` / `add` for FSM Worker Projects

| Field   | Value                                                                         |
| ------- | ----------------------------------------------------------------------------- |
| Status  | Accepted                                                                      |
| Date    | 2026-09-27                                                                    |
| Authors | Niraj, Claude                                                                 |
| Issue   | #373                                                                          |
| Affects | new `packages/fsm-cli-ts` (`@pgfsm/cli`), `packages/fsm-compiler-ts`, `docs/` |

> **Amended 2026-09-27 (#390):** `sync` is dropped from v1. Without it, nothing
> reads a list of FSMs and their sources, so `pgfsm.config.json` shrinks to a
> project marker (`name`, `toolVersion`), and `add --force` is how a version is
> regenerated after its source changes. `sync` and the `fsms[]` list move to
> #390. The sections below reflect the amended design.

---

## Problem

A new developer who wants to go from an FSM definition to running workers has
one entry point today: `@pgfsm/compiler -c generate-all`. It has three problems:

1. **The same command both creates and updates, and doesn't say which.** Point
   it at a folder in an empty directory and you get a new project. Point it at
   one `fsm.json` inside an existing project and the FSM is added to the
   `sync-worker/`/`async-worker/` stack already there. Nothing tells the
   developer which of the two happened, or which project was changed.
2. **Running it again destroys the developer's code.** Every compiler write is
   an unconditional `Deno.writeTextFile`: `writeOperationModule`
   (`actions|guards|delays/index.ts`), `writeActorFile` (each actor stub),
   `writeSyncWorkerRunner` (`run-sync-worker.ts` + `deno.json`), and
   `writeWorkerSdk` (`run-async-worker.ts`, `run_async_worker.py`,
   `src/main.rs`, `main.go`, and their `deno.json` / `pyproject.toml` /
   `Cargo.toml` / `go.mod`). So adding a second FSM with `generate-all`
   overwrites the implemented stubs of the first one if it is regenerated too
   (folder mode), and always overwrites the runner and manifest files.
3. **There's too much to know.** The developer has to know about `-c <command>`,
   `--fsm-name`/`--fsm-version`, `--lang`, `--project-name` (otherwise a random
   `sync-worker-xxxxxxxx` name is used), and, until #372, `--output` and a
   folder-dependent write root.

Who hits it: anyone adopting pgfsm outside this monorepo, which is the audience
for the npm-published packages (#358/#364/#368/#370 just published a worker SDK
for every language). Why now: the SDKs are published, so the missing piece for
"try it in five minutes" is the scaffolding experience.

## Constraints

- **Nothing added to the generated project's dependencies.** The generated
  project must not have the scaffolding tool as a dependency. The developer runs
  it through `npx` (or `deno run -A npm:…`), for both creating a project and
  adding FSMs later.
- **Polyglot output (ADR-003).** `async-worker/` contains one runnable project
  per language: `typescript` (Deno), `python` (uv/pyproject), `rust` (Cargo),
  and `go` (go.mod), each depending on that language's published
  `pgfsm-async-worker-sdk`. `sync-worker/` contains `typescript` only, because
  sync operation logic is TS-only today.
- **ADR-001 logging.** The CLI uses `@pgfsm/logging`, calling `configure()` once
  at its entry point.
- **The npm build runs on Node via dnt.** The compiler's npm build has no
  `Deno.Command` (so no `validate-async-operation` and no `deno fmt` pass).
  Importing a user's `machine.ts` also needs something that can run TypeScript.
  `fsm-devstack-ts/CLAUDE.md` records that this failed under Node before, and
  #270 fixed bare-specifier resolution but not TypeScript execution. Node ≥
  22.18 / 23.6 strips types by default, and `deno run -A npm:@pgfsm/cli`
  sidesteps the problem entirely. `fsm.json` input has no such dependency.
- **Generated workers run under Deno (TS), uv, cargo, and go.** Developers
  already need those toolchains to run what gets generated. The CLI itself only
  needs Node or Deno.
- **The compiler stays usable on its own.** `apps/fsm-core-example` and CI use
  the compiler directly with a non-standard layout. Nothing here may break that.
  #372 has already made `generate-all` write to cwd in every mode, and #376
  makes single-file `generate-fsm-json`/`generate-all` compile a `machine.ts`
  from its own location into `{cwd}/fsm/<N>/<V>/` (or copy a given `fsm.json`
  there), require `-N`/`-V`, and drop `--output` from every command.
- **`machine.ts` is never copied (#376).** A copy couldn't resolve its imports
  (bare `xstate` via the source tree's import map, or any relative import), so
  `fsm/` holds compiled `fsm.json`/`xstate-fsm.json` unless the developer keeps
  `machine.ts` there too.

## Options considered

### Option A — Add `create`/`add` to `@pgfsm/compiler`

New `-c create` and `-c add` commands in the existing CLI.

- **Pros:** one package, and no new publish pipeline.
- **Cons:** the compiler would have two ways of choosing where to write (current
  directory versus a project marker), which is the same kind of ambiguity this
  spec is meant to remove. The `-c <command> -f <folder>` flag style doesn't fit
  an interactive, prompt-driven tool. A bin named `fsm-compiler` is also the
  wrong name for "create my app".

### Option B — A new everyday CLI, `@pgfsm/cli` (bin `pgfsm`), built on the compiler library (proposed)

A new package that knows about projects. It calls the compiler's exported
functions in-process and never shells out to the compiler CLI. Optionally, a
tiny `@pgfsm/create` package makes `npm create @pgfsm` work, since npm maps
`npm create @scope` to `@scope/create`.

- **Pros:** clean division of work. The compiler stays the stateless, scriptable
  low-level tool. The new CLI owns project discovery, prompts, plans, and
  guardrails. The name has room for `validate`, `dev`, and so on later, and
  `fsmdev` (#245) could become `pgfsm dev`.
- **Cons:** one more package to publish and version, and its compiler dependency
  must be kept current.

### Option C — Fold it into `fsmdev` (`@pgfsm/devstack`)

- **Pros:** `fsmdev` already runs the generate step and aims to be npx-runnable
  (#245).
- **Cons:** `fsmdev` is a dev-stack orchestrator. It depends on
  `@pgfsm/sync-worker` and `@pgfsm/async-worker-gateway`, which makes it a heavy
  download just to scaffold files. It also isn't Node-portable yet (#245 is
  open). Tying scaffolding to it blocks this work on #245.

### Option D — Do nothing beyond #372 and documentation

Keep `generate-all` and document "folder = new project, file = add to current
directory" clearly.

- **Pros:** zero new code.
- **Cons:** it leaves problem 2 (regeneration overwrites user code) and problem
  3 (flags to learn) unsolved. "Did I just create or update?" stays something
  the developer has to know rather than something the tool tells them.

## Decision

**Option B**, with the ownership rule described below as a prerequisite change
to the compiler.

Decision drivers:

1. **Create and add must be separate, safe commands.** This is only reliable if
   the tool knows what a project is, which means a marker file, and that belongs
   in a project-aware tool rather than the stateless compiler (rules out A).
2. **Scaffolding must be a light npx download** (rules out C).
3. **Running it again must never destroy user code.** None of A–D gets this
   without a compiler change, so that change is required whichever option is
   chosen. Option D can't make use of it without also inventing a project
   concept, at which point it becomes B.

### Commands

```bash
npx @pgfsm/cli create <dir> [<source>] [--name <n>] [--dry-run]
npx @pgfsm/cli add <source> [--name <fsmName>] [--version <vNN>] [--force] [--dry-run]
# optional shim: npm create @pgfsm <dir> -- [<source>]
```

`<source>` is a folder (plugin root: `<fsmName>/<vNN>/{machine.ts|fsm.json}`), a
single `fsm.json`, or a single `machine.ts`. The CLI detects which one it is.

### Project layout (`create` output)

```
<dir>/
├── pgfsm.config.json          # project marker (schema below)
├── package.json               # scripts only, no dependencies (see "Version pinning")
├── README.md                  # next steps
├── deno.json                  # import map (xstate) so a machine.ts kept under fsm/ compiles in place
├── fsm/                       # compiled FSM definitions, written by the compiler (#376)
│   └── <fsmName>/<vNN>/{fsm.json, xstate-fsm.json?, machine.ts?}   # machine.ts only if kept here
├── sync-worker/typescript/    # full Deno project: deno.json, run-sync-worker.ts,
│                              #   aggregate registry, <fsmName>/<vNN>/{actions,guards,delays}
└── async-worker/
    ├── typescript/            # deno.json, run-async-worker.ts, registry, <fsmName>/<vNN>/actors/...
    ├── python/                # pyproject.toml, run_async_worker.py, registry, ...
    ├── rust/                  # Cargo.toml, src/main.rs, registry, ...
    └── go/                    # go.mod, main.go, go-actors-registry-generated/, ...
```

All four async-worker language projects are created at `create` time and must
build and start even when no actors use that language, so an FSM that later uses
Go for the first time needs no new project setup.

### `pgfsm.config.json`

```json
{
  "name": "my-app",
  "toolVersion": "0.1.0"
}
```

Its existence is what makes a directory a project: `add` finds the project by
walking up to it, and `create` refuses to run where one already exists. `name`
becomes `sync-worker/typescript/deno.json`'s name (replacing the random
`sync-worker-<hex>`). `toolVersion` is used for the version-drift warning.

The project does not record where each FSM came from. With no `sync` to read it,
such a list would be written and never checked, and would silently go stale when
a design file moves. #390 brings it back together with `sync`; projects created
before then can fall back to the existing `fsm/<name>/<vNN>/fsm.json`.

### Where commands run

- **`create`** runs from the parent directory and creates `<dir>`. `create .` is
  allowed only if the directory is empty or contains just `.git` or a README. It
  refuses if a `pgfsm.config.json` is already there, and points to `add`.
- **`add`** can run from anywhere inside the project. It searches upward for
  `pgfsm.config.json` (the way git finds `.git`), and the first line of output
  names the project root it found. If none is found, it refuses: "No pgfsm
  project found. Run `npx @pgfsm/cli create` first." `-C <dir>` overrides the
  search.
- **`<source>` paths** resolve against the directory the command was run from.
  **Output paths** always resolve against the project root.

### `add` behaviour

1. Resolve the project and detect the source type.
2. Work out `fsmName`/`vNN`: flags first, then the `<fsmName>/<vNN>/` path, then
   the fsm.json `id` for the name. If still unknown, prompt in a terminal or
   fail in CI.
3. If `fsm/<fsmName>/<vNN>/` already exists, refuse, unless `--force` is given.
   The error offers both ways forward: `--force` to regenerate that version
   (e.g. after editing its source), or the next free version for a changed
   design. `add` never replaces an existing version by accident.
4. Call the compiler's `generateAll` in single-file mode for **only this FSM
   version**, with `writeRootAbsPath = projectRoot` and the
   `fsmName`/`fsmVersion` from step 2, in create-only mode (see the ownership
   rule). Since #376 this one call compiles a `machine.ts` in place (or copies a
   `fsm.json`) into `fsm/<fsmName>/<vNN>/` and scaffolds both workers. Nothing
   is written if compilation fails.
5. Print the plan or result grouped by worker, with `+` created, `~`
   regenerated, and `=` kept, and end with next steps.

**Updating an FSM after editing its source** is
`add <source> -N <name> -V <vNN>
--force`: the same generation as a first `add`,
in the same `generated-only` mode, so stubs and entry files are kept and missing
exports are reported.

### File ownership rule (compiler change, prerequisite)

Every file the compiler writes falls into one of two classes:

| Class                                      | Files                                                                                                                                                                                                                                                                  | On re-run               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **Generated** (compiler-owned)             | `fsm.json`, `xstate-fsm.json`, per-version and aggregate registries (`generated-*registry*`, `*-actors-registry.generated.*`, `go-actors-registry-generated/`), `actors-manifest.json`, actor barrels, and the Go worker module (`async-worker/go/go.mod` + `main.go`) | Always rewritten        |
| **Scaffolded** (user-owned after creation) | `actions/index.ts`, `guards/index.ts`, `delays/index.ts`, each actor stub, each Go actor's own `go.mod`, `run-sync-worker.ts`, `run-async-worker.ts`, `run_async_worker.py`, `src/main.rs`, their `deno.json`/`pyproject.toml`/`Cargo.toml`, and `.gitignore`s         | Written only if missing |

Implemented in #381, with one change from the original table: the Go worker's
`go.mod` lists a `require`/`replace` for every Go actor module, so it can't be
left untouched once a Go actor is added, and `main.go` must match the SDK
version that `go.mod` pins. Both are generated; a Go actor's own dependencies go
in that actor's `go.mod`.

Generated files carry a do-not-edit header. Stub modules need one more step:
when an FSM gains a new action, the existing `actions/index.ts` is kept and the
CLI reports the missing export names for the developer to add (e.g. "3 new
actions: add them to …/actions/index.ts") rather than regenerating the file.
Compiler validation (`validate-sync-operation`) already catches a missing
export.

This becomes a compiler option (e.g. `overwrite: "generated-only" | "all"`) that
defaults to `"all"`, so today's compiler CLI behaviour doesn't change.
`@pgfsm/cli` always passes `"generated-only"`.

### Version pinning without a dependency

`create` writes `package.json` scripts that pin the CLI version:

```json
{
  "scripts": {
    "fsm:add": "npx -y @pgfsm/cli@<toolVersion> add"
  }
}
```

Plain `npx @pgfsm/cli` still works. The CLI compares its own version with
`toolVersion` and warns if they differ. It never rewrites `toolVersion` on its
own; `pgfsm upgrade` (out of scope) would do that.

### Role of `@pgfsm/compiler` afterwards

It becomes the low-level, stateless, non-interactive toolkit: CI validation,
non-standard layouts like `apps/fsm-core-example`, running a single step, and
the library API that `@pgfsm/cli` is built on. Its README points newcomers to
`@pgfsm/cli`.

## Consequences & migration

- **Harder:** the ownership rule means a template improvement to a runner or
  manifest no longer reaches existing projects automatically. That needs a
  future `pgfsm upgrade`, or the developer applies it by hand. It's the right
  trade-off (the alternative is silently losing their code), but it is a real
  cost.
- **Harder:** one more npm package to publish and version.
  `.github/workflows/npm-publish.yml` needs a new matrix entry, built with dnt
  for the `bin`, like the compiler.
- **Harder:** without `sync`, the developer has to remember each FSM's source
  path, name and version to regenerate it (`add ... --force`), since the project
  doesn't record them. Keeping a `machine.ts` under `fsm/<N>/<V>/` (which the
  project `deno.json` lets compile in place) makes that path predictable. #390
  removes this cost.
- **Harder:** stubs aren't merged, so new action or actor names are reported
  rather than written for existing modules.
- **Migration:** existing hand-assembled projects (built with `generate-all`)
  opt in by adding a `pgfsm.config.json`. `pgfsm init` could adopt an existing
  layout in place (see open questions). The compiler CLI is unchanged apart from
  #372 and the new opt-in overwrite option.
- **Rollback:** `@pgfsm/cli` is additive. Deprecating it on npm leaves the
  compiler CLI working exactly as before. The ownership option defaults to
  today's behaviour, so reverting it is a one-line change in the CLI.

## Acceptance criteria

- [ ] `npx @pgfsm/cli create my-app <src>` works for a folder, a single
      `fsm.json`, and a single `machine.ts`, and produces the layout above with
      `pgfsm.config.json`.
- [ ] After `create`, each of `sync-worker/typescript` and the four
      `async-worker/<lang>` projects type-checks or builds (`deno check`,
      `uv sync` plus import, `cargo check`, `go build`) with no manual edits,
      including languages no actor uses.
- [ ] The generated project's `package.json` has no `dependencies` or
      `devDependencies`.
- [ ] `create` refuses a directory that already contains `pgfsm.config.json` and
      names `add` in its error. `create .` refuses a non-empty directory.
- [ ] `add` run from any subdirectory of the project targets the project root
      and prints that root first. Outside a project it exits non-zero with the
      "run create first" message and writes nothing.
- [ ] `add <src>` for a new FSM creates `fsm/<name>/<vNN>/`, its stubs in the
      correct language projects, and updated registries, and changes no
      scaffolded file that already exists (verified by content hash before and
      after).
- [ ] After a developer edits a stub, `add` of a different FSM and `add --force`
      of the same FSM leave that edit byte-identical.
- [ ] `add` of an existing `<name>/<vNN>` exits non-zero, suggesting `--force`
      and the next version. `--force` regenerates only that version's `fsm.json`
      and generated files.
- [ ] `add` of a `machine.ts` outside the project writes `fsm/<name>/<vNN>/`
      `fsm.json` + `xstate-fsm.json` (no `machine.ts` copy).
- [ ] `pgfsm.config.json` is `{ name, toolVersion }` only.
- [ ] A `machine.ts` moved into `fsm/<name>/<vNN>/` compiles in place via the
      project `deno.json`, with no other setup.
- [ ] `--dry-run` on `create` and `add` writes nothing and prints the
      `+`/`~`/`=` plan.
- [ ] Missing name or version fails in non-interactive mode, naming the flag,
      and prompts in a terminal.
- [ ] `machine.ts` input works under `deno run -A npm:@pgfsm/cli` and under Node
      versions with default type stripping. On older Node it fails with a
      message naming the minimum version and the fsm.json alternative.
- [ ] The compiler's new overwrite option defaults to today's behaviour, and the
      full compiler test suite passes unchanged.
- [ ] `@pgfsm/cli` is published by `npm-publish.yml`, and
      `npx @pgfsm/cli
      --help` works from a clean machine.

## Open questions (for review)

1. **All four async-worker languages always, or only the ones used?** This spec
   says always, as requested, for zero setup later. The alternative is
   `create --langs`, with `add` creating a missing language project on first
   use.
2. **`pgfsm init`** to adopt an existing `generate-all` layout in place: part of
   v1 or a follow-up?
3. **Ship the `@pgfsm/create` shim in v1?** It's a nice-to-have, since
   `npx @pgfsm/cli create` already works.
4. **`fsmdev` convergence:** should #245 land as `pgfsm dev` inside this package
   instead of making `@pgfsm/devstack` npx-runnable on its own?

## Implementation

| Step | What                                                                            | Issue / PR               |
| ---- | ------------------------------------------------------------------------------- | ------------------------ |
| 1    | Compiler: file ownership, `overwrite: "generated-only"`                         | #381 / #387              |
| 2    | Compiler: single-FSM-version generation with explicit identity into `{cwd}/fsm` | #372 / #374, #376 / #378 |
| 3    | New `packages/fsm-cli-ts`: `create`, `add`, project discovery, plan printer     | #382 / #389              |
| 4    | Publish `@pgfsm/cli`, compiler release, docs                                    | #383                     |
| —    | Deferred: `sync` (#390), `@pgfsm/create` shim (#384), `pgfsm init` (#385)       |                          |

Differences from the text above, found while implementing #382:

- FSM identity flags are `-N`/`--fsm-name` and `-V`/`--fsm-version` (not
  `--name`/`--version`: `--version` prints the CLI version); `--name` is the
  project name on `create`.
- The project `deno.json` also sets `"nodeModulesDir": "auto"`: Deno resolves a
  machine.ts through the working directory's config, and `package.json`'s
  presence would otherwise switch Deno to an uninstalled `node_modules`.
- Under Node, a machine.ts's bare imports fall back to `@pgfsm/compiler`'s own
  dependencies, so a machine.ts importing only `xstate` needs no config at all.
- The CLI runs `go mod tidy` itself: the compiler's npm build can't spawn
  processes, so an npx-created project would otherwise lack `go.sum`.
