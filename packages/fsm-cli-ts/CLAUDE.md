# CLAUDE.md — `@pgfsm/cli` (`packages/fsm-cli-ts/`)

Project-aware CLI (bin `pgfsm`) that implements SPEC-004
(`docs/specs/spec-004-pgfsm-cli-create-add.md`): `create` and `add`. `sync` is
deferred to #390 (its implementation lived in #389's first commit). `README.md`
is the npm-facing document; keep source-only detail here.

## Commands

```bash
deno task pgfsm -- <args>   # run the CLI from source
deno task test              # from the repo root: deno test --allow-all packages/fsm-cli-ts
deno task check
deno task build:npm <version>   # dnt build to dist/ (see "npm build" below)
```

Tests assume the process cwd is the repo root (they build absolute paths from
it), like `fsm-compiler-ts`'s.

## Layout

- `src/cli/pgfsm.ts` — arg parsing, prompting, output, exit codes. The plan and
  next steps are printed with `console.log` (they're the UI); `@pgfsm/logging`
  is configured once here (ADR-001) for diagnostics, with `@pgfsm/compiler`'s
  own categories at `warning` unless `--verbose`.
- `src/commands/{create,add}.ts` — the operations, as library functions.
- `src/project.ts` — `pgfsm.config.json` read/write and upward discovery.
- `src/source.ts` — `<source>` → FSM versions with resolved identity.
- `src/report.ts` — collects `@pgfsm/compiler`'s `FileWriteEvent`s (one per
  file) and renders the `+created ~regenerated =kept` summary.
- `src/sandbox.ts` — `--dry-run`: runs the same code against a throwaway copy.
- `src/go-tidy.ts` — `go mod tidy` after a real run.

## Design points

- **All generation goes through `@pgfsm/compiler`'s library**, never its CLI:
  `generateAll` (single-file mode, one call per FSM version) for `add`,
  `scaffoldWorkerProjects` for the empty per-language projects `create` lays
  down, always with `overwrite: "generated-only"` (#381) so stubs and entry
  files are never rewritten.
- **Identity is resolved here, never in the compiler.** `-N`/`-V` flags, then
  the file's own `<fsmName>/<vNN>/` folders (only when the version folder
  matches `vNN`), then an fsm.json's `id` for the name (not xstate's default
  `(machine)`), then a prompt — or an error naming the flags when not
  interactive. `--name`/`--version` from the spec's draft became `-N`/`-V`
  because `--version` prints the CLI version.
- **`pgfsm.config.json` is only a marker** (`{ name, toolVersion }`): `add`
  finds the project by walking up to it, `create` refuses where one exists.
  Nothing records where each FSM came from — only `sync` would read that (#390)
  — so regenerating after a source edit is `add <source> -N -V --force`.
  `--force` skips the "version exists" refusal, whose job is catching a typo'd
  name/version or a clashing design.
- **Dry run = sandbox.** The compiler has no plan-only mode, so `--dry-run`
  copies the project (minus `.git`, `node_modules`, `target`, `.venv`, `dist`)
  into a temp dir named like the real root (the Go module root is derived from
  that name), runs the real code, remaps event paths back, and deletes the copy.
- **machine.ts import resolution differs by runtime.** Deno resolves a
  dynamically imported file through the config found from the _working
  directory_, so `create` writes a root `deno.json` mapping `xstate` with
  `nodeModulesDir: "auto"` (a `package.json` would otherwise switch Deno to
  manual node_modules). Under Node, `@pgfsm/compiler`'s resolve hook reads the
  file's nearest `deno.json`, then falls back to the compiler's own dependencies
  (`xstate` included). Running from source inside this monorepo picks up the
  monorepo's config instead — which is why tests keep fixtures under
  `.test-fixtures/` in this package, where this package's `deno.json` maps
  `xstate`. `MachineImportError` turns an unresolved import into advice.
- **`go mod tidy` lives here too**, because the compiler's npm build can't spawn
  processes (no `Deno.Command` in dnt's shim), so an npx-created project would
  otherwise have no `go.sum`. Tests set `PGFSM_SKIP_GO_TIDY=1` (network).

## npm build

`scripts/build-npm.ts` (dnt, like `@pgfsm/compiler`) maps `@pgfsm/compiler` and
`@pgfsm/logging` to real npm dependencies, ranged from their `deno.json`
versions. `@pgfsm/cli` needs a compiler release containing #376/#381/#382's
compiler changes (tracked by #383). Before that exists, build the compiler first
and set `PGFSM_LOCAL_COMPILER=1` to depend on its local `dist/` instead.
`src/version.node.ts` is generated per build and gitignored.

Published by `.github/workflows/npm-publish.yml`'s `cli` matrix entry on a
`cli-v<version>` tag (dnt path, `--copy-readme`). Tag only after the compiler
release it depends on is on npm (#383): the build maps `@pgfsm/compiler` to
`^<its deno.json version>`, so against an older published compiler the dnt
type-check fails and nothing is published.
