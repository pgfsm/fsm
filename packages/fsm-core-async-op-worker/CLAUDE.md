# CLAUDE.md — Activity Gateway (`packages/fsm-core-async-op-worker/`)

Scoped guidance for `@pgfsm/async-worker`. Repo-wide conventions and session
protocol live in the root `CLAUDE.md` / `AGENTS.md`.

## What it is

The Activity Gateway for async-operation-type FSM operations across polyglot
(TypeScript/Python/Rust/Go) actors — a standalone alternative to
`fsm-async-worker-ts` (v1, now `@pgfsm/async-worker-old`), not something that
integrates with or is invoked by it. It owns its own poll/dispatch/archive loop
end to end. Two CLIs: `async-operation-worker-gateway` (the long-running
gateway/sidecar/poll-loop process) and `async-operation-worker-gateway-ctl` (a
debug/test client). `README.md` is the npm/npx-consumer-facing document
(published to `dist/` — see below); keep source-only detail here instead of
there.

Full flag reference, examples, and the PGMQ dispatch model live in
[`docs/guides/CLI-USAGE.md`](./docs/guides/CLI-USAGE.md). The goal-vs-current
scoping record (target behavior, comparison table, known gaps) is
[`GOAL.md`](./GOAL.md) — a design/scoping note, not applied code changes.

## Commands

```bash
deno task gateway      # async-operation-worker-gateway — start the gateway
deno task gateway-ctl  # async-operation-worker-gateway-ctl — debug/test client
deno task check        # deno check src/index.ts
deno task build:npm    # scripts/build-npm.ts (dnt npm build)
```

Deno version is managed by `.prototools`: `proto install deno --pin local`.

## npm publish (`deno task build:npm`)

`scripts/build-npm.ts` builds the npm package via `@deno/dnt`, modeled on
`fsm-compiler-ts`'s and `fsm-sync-worker-ts`'s build scripts — see
`packages/fsm-compiler-ts/CLAUDE.md`'s "npm publish" section for why dnt (not
`deno pack`) is required to ship CLI `bin` entries. Registers both the library
export and the shebanged `async-operation-worker-gateway`/
`async-operation-worker-gateway-ctl` bins. `.github/workflows/npm-publish.yml`'s
`async-worker` matrix entry points at this package (repointed from
`fsm-async-worker-ts`/v1 in #175/#176, once this package took over the
`@pgfsm/async-worker` name in #171).

`postBuild()` only copies `README.md` into `dist/` when `--copy-readme` is
passed (`deno task build:npm <version> --copy-readme`, as CI does) — a plain
local `deno task build:npm` skips it.

This package also depends on `@pgfsm/proto-codegen` (generated
Connect/protobuf/gRPC-Node code, `node:net` usage) — unlike sync-worker's dnt
build, this one has to carry that dependency graph through dnt's type-check and
bundling. Verified clean as of #176; if it breaks again, that's the first place
to look.

**`Deno.remove`/`Deno.removeSync` don't throw `Deno.errors.NotFound` under the
npm/npx build (#278)**: `@deno/shim-deno`'s `remove`/`removeSync` rethrow a
missing-path failure as a raw, unwrapped Node `fs.rm`/`fs.rmSync` error
(`.code === "ENOENT"`) rather than a `Deno.errors.NotFound` instance — unlike
its `stat`/`lstat`/`readTextFile`/`readDir`, which do map through correctly.
This broke `gatewayServer.ts`'s `cleanupUnixSocket` and `sidecar/gateway.ts`'s
`cleanupSocket` (both a best-effort "delete any leftover socket file from a
previous run" that's supposed to ignore a missing one) — the gateway crashed on
startup under `npx` even on a completely fresh run with no stale socket. Use
`src/util.ts`'s `isNotFoundError(error)` instead of a bare
`error
instanceof Deno.errors.NotFound` check anywhere this "ignore a missing
path" pattern is built on a non-recursive `Deno.remove`/`Deno.removeSync` — it
recognizes both real Deno's `Deno.errors.NotFound` and the shim's unwrapped
`ENOENT`. `fsm-compiler-ts` has its own copy of the same helper (its own
`Deno.remove` call sites are a different package, same upstream shim gap) — see
that package's own `CLAUDE.md`.

**Multi-bin `npx` gotcha**: because this package registers two bins and neither
is named `async-worker` (the derived executable name from the package name), a
plain `npx @pgfsm/async-worker async-operation-worker-gateway ...` does **not**
work — npm can't determine which bin to run and errors
`could
not determine executable to run` (verified empirically against a scratch
multi-bin package). The correct form is
`npx -p @pgfsm/async-worker -- async-operation-worker-gateway ...` (or a real
install, after which each bin is callable directly) — see `README.md`'s Install
section, which documents this. Same issue applies to `fsm-sync-worker-ts` (four
bins) — see its `CLAUDE.md`.

## Structure (`src/`)

- `cli/` — two CLI entry points (`async-operation-worker-gateway.ts`,
  `async-operation-worker-gateway-ctl.ts`)
- `gatewayServer.ts` — sidecar + gRPC/Connect server, wired together
- `gatewayClient.ts` — client for the gRPC/Connect API (`ActivityGatewayClient`)
- `sidecar/` — worker registration + dispatch over the Unix socket
  (`SidecarGateway`)
- `asyncOpPollLoop.ts` — the Postgres poll/claim/archive loop
