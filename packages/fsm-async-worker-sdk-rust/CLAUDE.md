# CLAUDE.md — Rust Async Worker SDK (`packages/fsm-async-worker-sdk-rust/`)

Scoped guidance for the `pgfsm-async-worker-sdk` crate
(`use
pgfsm_async_worker_sdk`). Repo-wide conventions and session protocol live
in the root `CLAUDE.md` / `AGENTS.md`. `README.md` is the crates.io-facing
document; keep source-only detail here.

## Commands

A standalone crate (not part of a Cargo workspace), using the root
`rust-toolchain.toml` toolchain. `Cargo.lock` is committed so CI and releases
build with `--locked`.

```bash
cargo test                                  # unit + integration tests (no database; in-process tonic gateway)
cargo clippy --all-targets -- -D warnings   # CI treats warnings as errors
cargo fmt
cargo publish --dry-run                     # package + build exactly what crates.io would get
```

## What it is

Rust counterpart of `@pgfsm/async-worker-sdk`
(`packages/fsm-async-worker-sdk-ts/`) and the Python `pgfsm-async-worker-sdk`
(`packages/fsm-async-worker-sdk-python/`): `ActorWorker` (`src/actor_worker.rs`)
and the `list`/`start` CLI handling `run_actor_worker_cli` (`src/cli.rs`). Until
#368, `fsm-compiler-ts` wrote the worker into every project as
`async-worker/rust/src/sdk.rs` + a full `main.rs` (from
`worker-sdk-sdk.eta`/`worker-sdk-main.eta`), with a `Cargo.toml`
`path =`-depending on this monorepo's `packages/fsm-proto-codegen/gen/rust`. Now
`generate-async-logic` writes only a thin `src/main.rs`
(`rust/worker-sdk-main.eta`) and a `Cargo.toml` depending on this crate
(`rust/worker-sdk-cargo-toml.eta`).

Depends on the published `pgfsm-proto-codegen` crate (crates.io) for the
`pgfsm.sidecargateway.v1` stubs, not the monorepo's
`packages/fsm-proto-codegen/gen/rust/` directly. `prost`/`tonic`/`tonic-prost`
must all share one major with that crate's (0.14 today) — see
`packages/fsm-proto-codegen/README.md`.

Actors are linked into the worker binary: Rust has no runtime mechanism to load
a function out of a `.rs` file the way TypeScript's `import()` or Python's
`importlib` can. A missing or mistyped actor is a compile error in the generated
worker, not a startup error.

## Rules

- **No database access.** This runs inside every actor process; connections stay
  in the gateway (root `CLAUDE.md` point 4).
- **Library only uses the `log` facade.** The generated `main.rs` installs
  `env_logger` once (`info` by default, `RUST_LOG` overrides). Never install a
  logger from library code.
- **`run_actor_worker_cli` returns an exit code** instead of calling
  `process::exit`, so it stays testable. It's sync and builds its own tokio
  runtime for `start`, so the generated `main.rs` needs no async runtime or
  tokio dependency. Don't call it from inside another tokio runtime (it would
  panic on the nested runtime). SIGINT/SIGTERM go through `tokio::signal` and
  stay routed there for the rest of the process; there's no handler to restore,
  unlike the Python SDK.
- **`ActorRegistration::new`'s six identity arguments are the contract with the
  compiler's registries** (`rust/actors-registry.eta`,
  `rust/actors-registry-aggregate.eta`, `rust/shared-async-op-registry.eta`).
  Those registries define their own `ActorRegistration` struct (`&'static str`
  fields + a `fn(serde_json::Value) -> serde_json::Value` handler) and don't
  import this crate, because `create-async-logic` writes registries without a
  `Cargo.toml`. The generated `main.rs` maps one into the other. Keep them in
  step if either side changes.
- A panicking handler becomes an `INTERNAL` invoke error; the worker keeps
  running. `stop()` is sync, doesn't block, and is safe to call from any thread.
- `ActorRegistration::with_max_concurrency` sets `meta.max_concurrency`; the
  compiler's registries carry the actor stub's `MAX_CONCURRENCY` as
  `max_concurrency` (0 when unset), and the generated `main.rs` calls it (#435).
- CLI errors print the whole error `source()` chain: tonic's top-level
  connection error is just "transport error".

## Tests

- `src/cli.rs`'s unit tests cover argument parsing.
- `tests/actor_worker.rs` runs `ActorWorker` end to end against a fake
  `SidecarGatewayService` (a real tonic server built from the same stubs) on a
  temp Unix socket:
  - register, then a heartbeat
  - an invoke that succeeds, a panicking handler → `INTERNAL`, an unknown actor
    → `NOT_FOUND`
  - `stop()` sends an unregister and `run()` returns
  - a rejected registration, and an empty registry
  - the CLI's `start` path, returning 0 when the gateway ends the stream
  - the CLI exiting without waiting for a handler stuck in its blocking thread
- `tests/transport_concurrency.rs` covers SPEC-007 over real TCP sockets (see
  below).
- `tests/cli.rs` covers the CLI's exit codes and flag validation.

CI runs all of it (`ci.yml`, `rust-async-worker-sdk` job: fmt, clippy
`-D warnings`, test, `cargo publish --dry-run`).

## Transport, concurrency and drain (SPEC-007, #433)

Same behaviour as the TypeScript (#431) and Python (#432) SDKs; keep them in
step.

- **Addresses.** `gateway_address` (`unix:` / `https://` / `http://`) is parsed
  by `parse_gateway_address` in `ActorWorker::new`; an invalid one makes `run()`
  fail at once. `gateway_socket_path` is the `unix:` fallback. `endpoint()`
  builds a **new** tonic `Endpoint` per session (so a reconnect after the
  gateway's max-age drain can reach another replica) and reads the token, CA and
  client certificate then, so rotated files apply from the next session. The
  token goes as request metadata (`authorization: Bearer`).
- **TLS** is tonic's rustls (`tls-ring`), with `tls-native-roots` for the system
  trust store when no CA file is given. A refused handshake (no client
  certificate, an untrusted or expired server certificate) is a transport error
  or a non-fatal status, so `run()` retries it; `error_chain` puts the rustls
  reason in the log ("transport error" alone says nothing).
- **Keepalive** is `Endpoint::http2_keep_alive_interval` / `keep_alive_timeout`
  / `keep_alive_while_idle`. TCP only.
- **Concurrency.** The serve loop doesn't run handlers inline: each invoke is a
  tokio task that takes a permit from its actor's `Semaphore` (sized by
  `effective_max_concurrency(actor, worker)`, also sent in `Register`), then
  runs the sync handler on `spawn_blocking` inside `catch_unwind`. Results go to
  that invoke's own session through `SessionOutbox`; tasks hold an `Arc` of it,
  not a sender clone, so closing it still ends the request stream, and a late
  result is detected and logged as dropped.
- **Drain.** `stop()` records the drain deadline and flips the `stopping`
  `watch` flag. The serve loop then refuses invokes with a retriable
  `WORKER_DRAINING`, waits for the in-flight count (a `watch<usize>` kept by an
  `InFlight` guard) to reach 0 or the deadline, closes the request stream with
  an unregister, and keeps reading until the gateway ends its side (at most
  `CLOSE_WAIT`): returning right away dropped the connection before the
  unregister went out. `run()` stops reconnecting once stopping and returns
  after the drain.
- **CLI exit.** `run_actor_worker_cli` ends with `shutdown_background()`:
  dropping the runtime would wait for a handler still blocking past the grace
  period.

Tests: `tests/transport_concurrency.rs` runs a tonic server (TLS/mTLS via
`ServerTlsConfig`, max age via `Server::max_connection_age`) that checks the
bearer token like the real gateway: TLS + token, token re-read after a
reconnect, wrong token, mTLS with/without a client certificate, an untrusted
server certificate, plaintext, worker-wide and per-actor concurrency, drain and
its grace limit, max-age reconnect, an invalid address. TLS fixtures come from
`openssl` at test time (no committed keys). The real connect-node gateway isn't
started here (it's Deno); interop with it was checked by hand for #433 (mTLS +
token, concurrency, max-age reconnect, SIGTERM drain, wrong token).

## Environment variables (#438)

Every CLI option except `--help` falls back to `PGFSM_<LONG_NAME>` (`-` → `_`):
flag → variable → default, an empty variable counts as unset, and
`--gateway-socket`/`--gateway-address` are one setting (a flag for either
overrides both variables). Same option list (`ENV_OPTIONS`/`EnvOptions`), names,
precedence and error messages in all four SDKs; change them together.
`parse_args_with_env(args, env)` in `src/cli.rs` (`parse_args` passes
`std::env::var`): flags are collected first, unset options filled from
variables, then every value is validated with its source label
(`ParsedArgs.sources`, also used by `check_readable`). Unit tests pass a fake
env, so a stray `PGFSM_*` in CI can't leak in. No `.env` loading in the SDK: the
CLI is library code inside the user's process, so the README points at
`--env-file` (Deno, uv) or `set -a`.

## Releasing

`.github/workflows/crates-publish.yml` publishes to crates.io when an
`async-worker-sdk-rs-v<version>` tag is pushed. It checks the tag against
`Cargo.toml`'s version, runs `cargo test --locked`, then `cargo publish` with
the `CARGO_REGISTRY_TOKEN` secret. A re-run skips a version that's already on
crates.io. This release is independent of `pgfsm-proto-codegen`, which publishes
from `proto-publish.yml` on `proto-v*` tags.

1. **Pick the version** (below 1.0): a breaking API change → minor; new
   backward-compatible features → minor; fixes only → patch.
2. **Bump it in an issue-linked PR:** set `version` in `Cargo.toml`, run
   `cargo update -p pgfsm-async-worker-sdk` so `Cargo.lock` matches, commit
   both.
3. **If it needs a newer `pgfsm-proto-codegen`:** release proto-codegen first
   (`proto-v*`, see `packages/fsm-proto-codegen/README.md`), then raise the
   dependency here in the same PR.
4. **After merge, with `main` green, tag and push:**
   `git fetch origin && git tag async-worker-sdk-rs-v<version> origin/main && git push origin async-worker-sdk-rs-v<version>`.
   A pushed tag publishes publicly and can't be undone, so agents only push one
   when the user asks.
5. **Check the release:** watch the run
   (`gh run list --workflow crates-publish.yml`), then confirm
   https://crates.io/crates/pgfsm-async-worker-sdk lists it.

### Letting generated projects use a new minor version

Generated projects depend on `pgfsm-async-worker-sdk = "0.3"` (Cargo's
`>=0.3.0, <0.4.0`), so they won't pick up `0.4.0` until that moves. It lives in:

- `packages/fsm-compiler-ts/src/scaffold-templates/eta/rust/worker-sdk-cargo-toml.eta`,
  then, in `packages/fsm-compiler-ts`, run
  `deno task generate:templates && deno fmt src/scaffold-templates`.
- `packages/fsm-compiler-ts/test/operation-logic-scaffold.test.ts`, which
  asserts the dependency line.
- `test-apps/debug-only/async-worker/rust/Cargo.toml`, the committed generated
  copy.

Patch releases need none of this.

### If something goes wrong

- **Tag/version mismatch:** nothing was published. Delete the tag
  (`git push origin :refs/tags/<tag> && git tag -d <tag>`), fix the cause, and
  tag again.
- **Tests or the publish failed:** fix the cause and re-run the failed job.
- **A bad version shipped:** crates.io never accepts the same version twice.
  Release the next patch, then
  `cargo yank --version <bad> pgfsm-async-worker-sdk`.

## Using the crate from source

[`test-apps/debug-only/`](../../test-apps/debug-only/README.md) (#405) is the
in-repo worker project. To build its Rust worker against this directory, add a
`[patch.crates-io]` path entry to its `async-worker/rust/Cargo.toml` (see that
README's "Using local SDK source"), or for one command without editing any file:

```bash
cd test-apps/debug-only/async-worker/rust
cargo run --config "patch.crates-io.pgfsm-async-worker-sdk.path='../../../../packages/fsm-async-worker-sdk-rust'" -- list
```
