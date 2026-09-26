# CLAUDE.md — TypeScript Async Worker SDK (`packages/fsm-async-worker-sdk-ts/`)

Scoped guidance for `@pgfsm/async-worker-sdk`. Repo-wide conventions and session
protocol live in the root `CLAUDE.md` / `AGENTS.md`. `README.md` is the
npm-consumer-facing document (copied into `dist/` on publish); keep source-only
detail here.

## Commands

```bash
deno task test        # deno test --allow-all test/
deno task check       # deno check src/index.ts
deno task build:npm   # scripts/build-npm.ts (dnt npm build)
```

## What it is

Not to be confused with `packages/fsm-async-worker-ts/` — the deprecated v1
async-op worker fleet (`@pgfsm/async-worker-old`). This package is the client
SDK for the current Activity Gateway (`packages/fsm-async-worker-gateway-ts/`).
Named `async-worker-sdk` (not `worker-sdk`) because it only serves async actor
workers, not the sync side (`@pgfsm/sync-worker`).

The client end of the Activity Gateway's sidecar leg: `ActorWorker`
(`src/actorWorker.ts`) and the `list`/`start` CLI handling `runActorWorkerCli`
(`src/cli.ts`). Until #358, `fsm-compiler-ts` wrote both into every project as
`async-worker/typescript/sdk.ts`/`cli.ts` (from
`worker-sdk-sdk.eta`/`worker-sdk-cli.eta`). Now `generate-async-logic` writes
only a thin `run-async-worker.ts` (`run-async-worker.eta`) and a `deno.json`
pinning this package (`worker-sdk-deno-json.eta`), the same shape
`generate-sync-logic`'s `run-sync-worker.ts` has with `@pgfsm/sync-worker`.

Python followed in #364 (`packages/fsm-async-worker-sdk-python/`,
`pgfsm-async-worker-sdk` on PyPI) and Rust in #368
(`packages/fsm-async-worker-sdk-rust/`, `pgfsm-async-worker-sdk` on crates.io).
Go workers still get their SDK written out by the compiler (`sdk.go`); these
three packages are the reference for moving it to a published package too.

## Rules

- **No database access, no `pg`.** This runs inside every actor process;
  connections stay in the gateway (root `CLAUDE.md` point 4). Don't import
  `@pgfsm/async-worker-gateway` or `@pgfsm/db` from `src/` — the gateway package
  is a test-only dependency (`test/actorWorker.test.ts` starts a real in-process
  `SidecarGateway` against it).
- **Library only calls `getLogger()`.** Logging is configured once by the
  generated entry point (`@pgfsm/logging`'s `configureLogging`), not here.
- **`runActorWorkerCli` returns an exit code** instead of calling `Deno.exit()`,
  so it stays testable; the generated entry point exits with it.
- **`ActorRegistration` is duplicated structurally, not imported, by the
  generated registries** (`actors-registry.eta`,
  `shared-async-op-registry.eta`). `create-async-logic` writes registries
  without writing a `deno.json`, so a registry importing
  `@pgfsm/async-worker-sdk` wouldn't resolve in a project that only ran that
  command. TypeScript still checks the two shapes against each other where
  `run-async-worker.ts` passes `ACTOR_REGISTRATIONS` in. Keep the fields in sync
  if either side changes.

## npm publish

Built with `@deno/dnt` like the other published packages
(`.github/workflows/npm-publish.yml`, `async-worker-sdk` matrix entry, tag
`async-worker-sdk-v<version>`). There's no CLI bin; dnt is used so
`@pgfsm/proto-codegen`'s subpath imports map to a real npm dependency (range
read from `../fsm-proto-codegen/gen/typescript/deno.json`) instead of being
inlined. `test: false` keeps the gateway-backed tests out of dnt's Node test
run.

The compiler's `worker-sdk-deno-json.eta` pins
`npm:@pgfsm/async-worker-sdk@^0.1.0`. Bump that pin by hand when this package's
API changes in a way `run-async-worker.eta`'s call depends on.

Inside this repo, the committed `apps/async-worker/typescript/deno.json` uses
that same `npm:` pin, so `run-async-worker.ts` there only runs once the matching
version is published (same as `apps/sync-worker/` with `@pgfsm/sync-worker`).
Workspace code that needs the SDK directly (e.g. the example journey test)
imports `@pgfsm/async-worker-sdk` by its workspace name instead.

## Known behaviour

`ActorWorker.run()` doesn't notice the gateway going away: if the gateway
process exits, the worker keeps waiting until it's stopped (SIGINT/SIGTERM or
`stop()`). This predates the move out of the compiler (the old generated
`sdk.ts` behaves the same).
