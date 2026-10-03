# CLAUDE.md — Go Async Worker SDK (`packages/fsm-async-worker-sdk-go/`)

Scoped guidance for the Go module
`github.com/pgfsm/fsm/packages/fsm-async-worker-sdk-go` (package
`asyncworkersdk`). Repo-wide conventions and session protocol live in the root
`CLAUDE.md` / `AGENTS.md`. `README.md` is the pkg.go.dev-facing document; keep
source-only detail here.

## Commands

A standalone module (not part of a Go workspace). `go.sum` is committed; CI runs
with `-mod=readonly`, so `go.mod`/`go.sum` must already be tidy.

```bash
go test -race ./...   # unit + end-to-end tests (no database; in-process grpc-go gateway)
go vet ./...
gofmt -l .            # CI fails if this prints anything
go mod tidy           # after changing imports
```

## What it is

Go counterpart of `@pgfsm/async-worker-sdk`
(`packages/fsm-async-worker-sdk-ts/`), the Python `pgfsm-async-worker-sdk`
(`packages/fsm-async-worker-sdk-python/`) and the Rust `pgfsm-async-worker-sdk`
crate (`packages/fsm-async-worker-sdk-rust/`): `ActorWorker` (`actor_worker.go`)
and the `list`/`start` CLI handling `RunActorWorkerCLI` (`cli.go`). Until #370,
`fsm-compiler-ts` wrote the worker into every project as
`async-worker/go/sdk.go` + a full `main.go` (from
`go/worker-sdk-sdk.eta`/`go/worker-sdk-main.eta`), with a `go.mod` that
`replace`d the proto stubs to this monorepo's
`packages/fsm-proto-codegen/gen/go`. Now `generate-async-logic` writes only a
thin `main.go` (`go/worker-sdk-main.eta`) and a `go.mod` requiring this module
(`go/go-mod-aggregate.eta`, rendered by `writeWorkerSdk` with this module's
path/version constants, `GO_ASYNC_WORKER_SDK_MODULE_PATH` /
`GO_ASYNC_WORKER_SDK_VERSION` in `operation-logic-scaffold.ts`).

Requires the published `github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go`
module (from the Go module proxy) for the `pgfsm.sidecargateway.v1` stubs, with
no `replace` into the monorepo.

Actors are linked into the worker binary: Go has no practical runtime mechanism
to load a function out of a `.go` file (plugins need exact toolchain matching).
A missing or mistyped actor is a compile error in the generated worker.

## Rules

- **No database access.** This runs inside every actor process; connections stay
  in the gateway (root `CLAUDE.md` point 4).
- **Logging goes through `slog.Default()`.** The library never configures a
  logger or handler; a caller can `slog.SetDefault` first. The generated
  `main.go` doesn't, so it gets Go's default text output.
- **`RunActorWorkerCLI` returns an exit code** instead of calling `os.Exit`, so
  it stays testable. It restores default SIGINT/SIGTERM handling (`signal.Stop`)
  when it returns.
- **Protobuf messages are held by pointer** (`ActorRegistration.Meta` is
  `*RegisteredActor`). Generated messages embed a mutex and must not be copied;
  the pre-#370 generated `sdk.go` held them by value and `go vet` flagged it.
- **The drain half-closes the stream (`CloseSend`); it doesn't close the
  connection.** The gateway sees the unregister and end of stream, ends its
  side, and `Run()` returns `nil`. The pre-#370 `sdk.go` closed the connection,
  which made `Run()` return an error on a normal Ctrl-C (exit 1) and panicked if
  `Stop()` ran before `Run()` connected. `mu` guards `stopping` and `stream` and
  is never held across a `Send` (so `Stop()` never blocks); `sendMu` serializes
  `Send`/`CloseSend` (tests run with `-race`).
- `ActorRegistration.WithMaxConcurrency` sets `Meta.MaxConcurrency`; the
  compiler's Go registry doesn't emit it yet (#435). `NewActorWorker` clones
  each `Meta` (`proto.Clone`) before writing the effective limit into it.
- **`NewActorRegistration`'s six identity arguments are the contract with the
  compiler's Go registry** (`go/actors-registry-aggregate.eta` and
  `create-async-logic`'s shared-async-op Go registry). Those registries define
  their own `ActorRegistration` struct (six strings + a
  `func(input any) (any, error)` handler) and don't import this module, so they
  build without it. The generated `main.go` maps one into the other. Keep them
  in step if either side changes.

## Tests

- `cli_test.go`: argument parsing and the CLI's exit codes (same cases as the
  Python and Rust SDKs).
- `actor_worker_test.go`: `ActorWorker` end to end against a fake
  `SidecarGatewayService` (a real grpc-go server from the same stubs) on a temp
  Unix socket:
  - register, then a heartbeat
  - an invoke that succeeds; a handler error, a panic, and an unknown actor
    (`INTERNAL`, `INTERNAL`, `NOT_FOUND`)
  - `Stop()` sends an unregister and `Run()` returns `nil`
  - a rejected registration, an empty registry, and `Stop()` before `Run()`
  - the CLI's `start` path, returning 0 when the gateway ends the stream
- `transport_concurrency_test.go`: SPEC-007 over real TCP sockets (see below).

CI runs all of it (`ci.yml`, `go-async-worker-sdk` job: gofmt, vet, test
`-race`, all `-mod=readonly`).

## Transport, concurrency and drain (SPEC-007, #434)

Same behaviour as the TypeScript (#431), Python (#432) and Rust (#433) SDKs;
keep them in step.

- **Addresses.** `GatewayAddress` (`unix:` / `https://` / `http://`) is parsed
  by `ParseGatewayAddress` in `NewActorWorker`; an invalid one makes `Run()`
  fail at once. `GatewaySocketPath` is the `unix:` fallback. `dial()` opens a
  **new** `grpc.ClientConn` per session (so a reconnect after the gateway's
  max-age drain can reach another replica) and reads the token, CA and client
  certificate then, so rotated files apply from the next session. The token goes
  as outgoing metadata (`authorization: Bearer`), not per-RPC credentials, so it
  also works on the plaintext test mode.
- **Keepalive** is `grpc.WithKeepaliveParams`; grpc-go raises a `Time` below ten
  seconds to ten seconds. TCP only. Options keep this package's "zero means
  default" convention, so "disabled" is negative (`KeepaliveIntervalMs`,
  `ShutdownGraceMs`); the CLI maps its `0` to `-1` (`optionMs`).
- **TLS failures are retried.** A refused handshake (no client certificate, an
  untrusted server) surfaces as `Unavailable`, so `Run()` retries it.
- **Concurrency.** `serveLoop` starts a goroutine per invoke; each takes a slot
  from its actor's buffered channel (sized by
  `EffectiveMaxConcurrency(actor, worker)`, also sent in `Register`). Results go
  out through `sendOn(stream, ...)`, which drops them (logged) if `stream` is no
  longer the current session's, so a late result never lands on a later session.
- **Drain.** `Stop()` sets `stopping` under `mu`, closes `stopCh` and starts
  `drain()`: wait for `inFlight` (a `WaitGroup`; no `Add` after `stopping`, so
  no `Add`/`Wait` race) up to `ShutdownGraceMs`, then clear `stream`, send the
  unregister and `CloseSend`. Invokes that arrive while `stopping` get a
  retriable `WORKER_DRAINING`. `runSession` publishes its stream under `mu` only
  if not `stopping`, so the drain either sees it or no session starts. After the
  drain the session gets `closeWait` (5 s) for the gateway to end its side, then
  the call is cancelled. `Run()` returns after `drained`.

Tests: `transport_concurrency_test.go` runs a grpc-go server (TLS/mTLS via
`credentials.NewTLS`, max age via `keepalive.ServerParameters`) that checks the
bearer token like the real gateway: TLS + token, token re-read after a
reconnect, wrong token, mTLS with/without a client certificate, an untrusted
server certificate, plaintext, worker-wide and per-actor concurrency, drain and
its grace limit, max-age reconnect, an invalid address. TLS fixtures come from
`openssl` at test time (no committed keys; the client certificate gets an
extension so OpenSSL 3.0 issues v3). The real connect-node gateway isn't started
here (it's Deno); interop with it was checked by hand for #434 (mTLS + token,
concurrency, max-age reconnect, SIGTERM drain, wrong token).

## Environment variables (#438)

Every CLI option except `--help` falls back to `PGFSM_<LONG_NAME>` (`-` → `_`):
flag → variable → default, an empty variable counts as unset, and
`--gateway-socket`/`--gateway-address` are one setting (a flag for either
overrides both variables). Same option list (`ENV_OPTIONS`/`EnvOptions`), names,
precedence and error messages in all four SDKs; change them together.
`parseArgs(args, getenv)` in `cli.go` (`runCLI` passes `os.Getenv`): flags are
collected first, unset options filled from variables, then every value is
validated with its source label (`parsedArgs.sources`, also used by
`checkReadable`). Unit tests pass `noEnv`/`envOf`; the exit-code test uses
`t.Setenv`. No `.env` loading in the SDK: the CLI is library code inside the
user's process, so the README points at `--env-file` (Deno, uv) or `set -a`.

## Releasing

`.github/workflows/go-publish.yml` runs on an `async-worker-sdk-go-v<version>`
tag. It checks the version is semver (and that a v2+ release has a `/vN` module
path), runs `go vet` + `go test -race`, then pushes the module tag
`packages/fsm-async-worker-sdk-go/v<version>` at the same commit and asks
proxy.golang.org for it. A re-run skips a module tag that already points at the
same commit. The module tag is what Go resolves; Go has no registry upload and
no version field in `go.mod`.

1. **Pick the version** (below 1.0): a breaking API change → minor; new
   backward-compatible features → minor; fixes only → patch.
2. **Land the change in an issue-linked PR.** Nothing to bump in this module. If
   it needs a newer proto-codegen Go module, release that first (`proto-v*`, see
   `packages/fsm-proto-codegen/README.md`), then
   `go get github.com/pgfsm/fsm/packages/fsm-proto-codegen/gen/go@v<new>` here.
3. **After merge, with `main` green, tag and push:**
   `git fetch origin && git tag async-worker-sdk-go-v<version> origin/main && git push origin async-worker-sdk-go-v<version>`.
   A pushed tag publishes publicly and can't be undone, so agents only push one
   when the user asks.
4. **Check the release:** watch the run
   (`gh run list --workflow go-publish.yml`), then
   `go list -m github.com/pgfsm/fsm/packages/fsm-async-worker-sdk-go@v<version>`.

### Letting generated projects use a new version

Generated projects require `GO_ASYNC_WORKER_SDK_VERSION` (`v0.3.0` today) as a
minimum. Go's minimal version selection never upgrades that on its own, so bump
it whenever generated projects should get a new release (not just for minor
versions, unlike the other languages' ranges). It lives in:

- `GO_ASYNC_WORKER_SDK_VERSION` in
  `packages/fsm-compiler-ts/src/operation-logic-scaffold.ts`.
- `packages/fsm-compiler-ts/test/operation-logic-scaffold.test.ts`, which
  asserts the generated `go.mod`.
- `test-apps/debug-only/async-worker/go/go.mod` + `go.sum`, the committed
  generated copy (run `go mod tidy` there after the release is on the proxy).

### If something goes wrong

- **Tests failed:** nothing was released. Delete the `async-worker-sdk-go-v*`
  tag (`git push origin :refs/tags/<tag> && git tag -d <tag>`), fix the cause,
  and tag again.
- **A bad version shipped:** never move or delete a pushed module tag; the Go
  checksum database has already recorded it. Release the next patch with
  `retract v<bad> // reason` added to `go.mod`.

## Using the module from source

[`test-apps/debug-only/`](../../test-apps/debug-only/README.md) (#405) is the
in-repo worker project. Its Go worker requires the published module; to build it
against this directory, add a `go.work` next to its `go.mod` (`use .` plus a
`replace` of this module — see that README's "Using local SDK source"). Use
`go.work`, not a `replace` in `go.mod`: `go.mod` is compiler-owned and rewritten
by `pgfsm add`.
