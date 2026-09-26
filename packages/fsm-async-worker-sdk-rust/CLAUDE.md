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
  running. `stop()` is sync and safe to call from any thread.
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
- `tests/cli.rs` covers the CLI's exit codes.

CI runs all of it (`ci.yml`, `rust-async-worker-sdk` job: fmt, clippy
`-D warnings`, test, `cargo publish --dry-run`).

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

Generated projects depend on `pgfsm-async-worker-sdk = "0.1"` (Cargo's
`>=0.1.0, <0.2.0`), so they won't pick up `0.2.0` until that moves. It lives in:

- `packages/fsm-compiler-ts/src/scaffold-templates/eta/rust/worker-sdk-cargo-toml.eta`,
  then, in `packages/fsm-compiler-ts`, run
  `deno task generate:templates && deno fmt src/scaffold-templates`.
- `packages/fsm-compiler-ts/test/operation-logic-scaffold.test.ts`, which
  asserts the dependency line.
- `apps/async-worker/rust/Cargo.toml`, the committed generated copy.

Patch releases need none of this.

### If something goes wrong

- **Tag/version mismatch:** nothing was published. Delete the tag
  (`git push origin :refs/tags/<tag> && git tag -d <tag>`), fix the cause, and
  tag again.
- **Tests or the publish failed:** fix the cause and re-run the failed job.
- **A bad version shipped:** crates.io never accepts the same version twice.
  Release the next patch, then
  `cargo yank --version <bad> pgfsm-async-worker-sdk`.

## Using the crate from `apps/async-worker/rust` before a release

The committed `apps/async-worker/rust/Cargo.toml` depends on the published
crate, so `cargo run` there only works once a matching version is on crates.io
(same as the Python and TypeScript workers). Before then, point Cargo at this
directory for one command, without editing any file:

```bash
cd apps/async-worker/rust
cargo run --config "patch.crates-io.pgfsm-async-worker-sdk.path='../../../packages/fsm-async-worker-sdk-rust'" -- list
```

Don't commit the `Cargo.lock` that creates in `apps/async-worker/rust`.
