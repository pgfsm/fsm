# CLAUDE.md — Logging (`packages/fsm-logging-ts/`)

Scoped guidance for `@pgfsm/logging`. Repo-wide conventions and session protocol
live in the root `CLAUDE.md` / `AGENTS.md`. Full docs (rendering helpers, sink
internals, decision tables) are in this package's `README.md` — read it before
changing logging behavior.

## Commands

```bash
deno task build:npm    # scripts/build-npm.ts (dnt npm build)
```

Deno version is managed by `.prototools`: `proto install deno --pin local`.

## What it is

The single owner of logging config for the repo — wraps LogTape with one
process-wide configurator, a shared `CATEGORY` vocabulary (`api`, `worker`,
`db`, `compiler`, `fsmlet`), and a console sink that auto-renders
tables/objects.

## The golden rule

`configureLogging()` runs exactly once per process, at the entry point — calling
LogTape's `configure()` twice throws.

- **Apps/CLIs configure**: each composition root (API `deno.ts`/`logger.ts`,
  each worker CLI, the compiler CLI) resolves levels from its own validated env
  and calls `configureLogging()` once. See
  `apps/fsm-core-ts-hono-deno/CLAUDE.md`,
  `packages/fsm-sync-worker-ts/CLAUDE.md`, and
  `packages/fsm-async-worker-ts/CLAUDE.md` for the entry points that do this.
- **Libraries never configure**: they only `getLogger([CATEGORY.x, ...])` — e.g.
  `packages/fsm-core-db-ts/` only imports `CATEGORY`, never `configureLogging`.
- **Env is read at the composition root**, not here — this package takes
  explicit levels (dependency injection), never reads env itself.

## npm publish (`deno task build:npm`)

`scripts/build-npm.ts` builds the npm package via `@deno/dnt` (not `deno
pack`),
matching the pattern documented in `packages/fsm-compiler-ts/CLAUDE.md` —
consistency with every other published package here, not because this leaf
package needs a CLI `bin` or a `mappings`/`package.dependencies` override (it
has neither). Library-only build (no bin entries), no Node-specific shim files —
unlike `fsm-compiler-ts`, this package has no build-time-vs-runtime version
string to swap and no custom module-resolution hook to install.
`.github/workflows/npm-publish.yml` builds this package's `logging` matrix entry
through the dnt path.

`postBuild()` only copies `README.md` into `dist/` when `--copy-readme` is
passed (`deno task build:npm <version> --copy-readme`, as CI does) — a plain
local `deno task build:npm` skips it.

Both `@logtape/logtape` and `@logtape/otel` are imported via `npm:` specifiers
(not `jsr:`) in `deno.json` — `@logtape/otel` used to be `jsr:`-sourced until
#293 switched it, matching the `jsr:` → `npm:` fix #287/#288 already applied to
`@logtape/logtape` in `fsm-core-db-ts`. dnt's dependency auto-detection only
declares real `dependencies` for `npm:`-mapped specifiers; a `jsr:` one gets
vendored (transpiled inline into `dist/`) instead, which for `@logtape/otel`
would have pulled its transitive `@opentelemetry/*` packages in as this
package's own direct dependencies rather than `@logtape/otel`'s — confirmed
empirically pre-#293 in every package that vendored this one (`fsm-compiler-ts`,
`fsm-sync-worker-ts`, etc. all listed `@opentelemetry/*` packages directly). One
gotcha from making this switch: `@logtape/otel@2.3.6`'s peer dependency wants
`@logtape/logtape@^2.3.6`, but this repo's `deno.lock` still resolves
`@logtape/logtape` to `2.3.0` (from before `@logtape/otel` was ever pulled in
via `npm:` anywhere) — `deno check`/`deno task build:npm` both emit a peer-
dependency warning about this (non-fatal, build still succeeds) until the lock
entry is refreshed.
