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
`pgfsm-async-worker-sdk` on PyPI), Rust in #368
(`packages/fsm-async-worker-sdk-rust/`, `pgfsm-async-worker-sdk` on crates.io)
and Go in #370 (`packages/fsm-async-worker-sdk-go/`, the
`github.com/pgfsm/fsm/packages/fsm-async-worker-sdk-go` module). No language's
worker SDK is written out by the compiler any more.

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
`npm:@pgfsm/async-worker-sdk@^0.2.0`. Bump that pin by hand when this package's
API changes in a way `run-async-worker.eta`'s call depends on.

Inside this repo, the worker project is
[`test-apps/debug-only/`](../../test-apps/debug-only/README.md) (#405). Its
`async-worker/typescript/deno.json` uses the published `npm:` pin; to run it
against this package's source, map `@pgfsm/async-worker-sdk` to `src/index.ts`
there (see that README's "Using local SDK source"). Workspace code that needs
the SDK directly (e.g. the example journey test) imports
`@pgfsm/async-worker-sdk` by its workspace name.

## Transport, concurrency and drain (SPEC-007, #431)

- **Addresses.** `gatewayAddress` (`unix:` / `https://` / `http://`) is parsed
  once by `parseGatewayAddress`; `gatewaySocketPath` is shorthand for `unix:`.
  `openTransport()` builds a **new** `Http2SessionManager` per session (so a
  reconnect after the gateway's max-age drain can reach another replica), and
  reads the token, CA and client certificate then, so rotated files apply from
  the next session.
- **TLS sockets are ours.** For `https://`, `createConnection` returns a
  `tls.connect` socket whose `"error"` events are intercepted: logged, then the
  socket is destroyed _without_ an error. Under TLS 1.3 a gateway refuses a
  missing client certificate only after the handshake, and connect-node removes
  its session `"error"` listener on `"connect"` before attaching the next one,
  so that late alert used to become an unhandled session error and crash the
  process. Now the call fails and `run()` retries with backoff. Covered by the
  mTLS test in `test/transport_concurrency.test.ts`.
- **Concurrency.** `serveLoop` no longer awaits `handleInvoke`; each actor has a
  `Semaphore` sized by
  `effectiveMaxConcurrency(reg.maxConcurrency,
  options.maxConcurrency)`
  (actor, else worker, else 1), and that value is sent in `Register`. The local
  semaphore matters: the gateway can briefly send more than declared (after its
  own invoke timeout, or a direct `Invoke()`).
- **Drain.** `stop()` returns a promise: it refuses new invokes with a retriable
  `WORKER_DRAINING` error, waits for in-flight ones up to `shutdownGraceMs`,
  then unregisters and closes. `run()` doesn't reconnect while stopping and
  resolves after the drain.
- **CLI integers** reject empty values: `parseArgs` reads `--flag -1` as a
  separate flag `1`, leaving an empty string that `Number()` turned into 0.

Tests: `test/transport_concurrency.test.ts` runs a real in-process gateway over
real sockets (TLS + token, wrong token, mTLS with/without a client certificate,
plaintext, worker-wide and per-actor concurrency, drain, max-age reconnect),
with TLS fixtures made by `openssl` at test time (`test/tls_fixture.ts`; no
committed keys).

## Environment variables (#438)

Every CLI option except `--help` falls back to `PGFSM_<LONG_NAME>` (`-` → `_`):
flag → variable → default, an empty variable counts as unset, and
`--gateway-socket`/`--gateway-address` are one setting (a flag for either
overrides both variables). Same option list (`ENV_OPTIONS`/`EnvOptions`), names,
precedence and error messages in all four SDKs; change them together.
`resolveSettings(flags, env)` in `src/cli.ts`; `runActorWorkerCli` passes the
parsed flags and `options.env` (default `Deno.env.get`, swallowing a missing
`--allow-env`). Tests in `test/cli.test.ts` drive `resolveSettings` with a fake
env. No `.env` loading in the SDK: the CLI is library code inside the user's
process, so the README points at `--env-file` (Deno, uv) or `set -a`.

## Known behaviour

Over a Unix socket there's no keepalive: a crash there shows up immediately as
end of stream. Over TCP, HTTP/2 PINGs (`keepaliveIntervalMs`) detect a half-open
connection and the worker reconnects.
