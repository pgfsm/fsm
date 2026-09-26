# pgfsm-async-worker-sdk

Rust worker SDK for the pgfsm Activity Gateway. A worker process built on it
connects to the gateway's sidecar Unix socket, registers a set of actors, and
serves the invocations the gateway routes to them over the
`pgfsm.sidecargateway.v1.SidecarGatewayService` gRPC stream (stubs from
[`pgfsm-proto-codegen`](https://crates.io/crates/pgfsm-proto-codegen)).

It never opens a database connection — that stays in the gateway.

Rust counterpart of the TypeScript
[`@pgfsm/async-worker-sdk`](https://www.npmjs.com/package/@pgfsm/async-worker-sdk)
and the Python
[`pgfsm-async-worker-sdk`](https://pypi.org/project/pgfsm-async-worker-sdk/).

## Usage

You normally don't write against this crate directly. `@pgfsm/compiler`'s
`generate-async-logic` writes a small `src/main.rs` plus a `Cargo.toml` that
depends on this crate:

```rust
// async-worker/rust/src/main.rs (generated, abridged)
#[path = "../rust-actors-registry.generated.rs"]
mod generated_registry;

use pgfsm_async_worker_sdk::{run_actor_worker_cli, ActorRegistration};

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let registrations = generated_registry::actor_registrations()
        .into_iter()
        .map(|reg| ActorRegistration::new(
            reg.parent_fsm_name, reg.parent_fsm_version, reg.async_operation_type,
            reg.async_operation_name, reg.async_operation_version, reg.async_operation_language,
            reg.handler,
        ))
        .collect();
    std::process::exit(run_actor_worker_cli(registrations, std::env::args().skip(1), None));
}
```

Run it from that directory:

```bash
cargo run --release -- list    # print the actors in the registry, no gateway needed
cargo run --release -- start   # connect to the gateway and serve invocations
```

### Options

```
-g, --gateway-socket <path>   Sidecar socket to connect to (default: /tmp/pgfsm-activity-gateway-workers.sock)
-i, --worker-id <id>          Stable worker identity (default: rust-<random>)
    --heartbeat-ms <ms>       Heartbeat interval (default: 5000)
-h, --help                    Show this help message
```

SIGINT/SIGTERM stop the worker gracefully (it unregisters from the gateway).

## API

- `run_actor_worker_cli(registrations, args, invocation) -> i32`: the
  `list`/`start` CLI. Returns the process exit code instead of exiting. It
  builds its own tokio runtime, so call it from a plain (non-async) `main`.
- `ActorWorker::new(ActorWorkerOptions { worker_id, gateway_socket_path, heartbeat_ms }, registrations)`:
  `run().await` registers every actor and serves invocations until `stop()` is
  called or the gateway ends the stream.
- `ActorRegistration::new(parent_fsm_name, parent_fsm_version, async_operation_type, async_operation_name, async_operation_version, async_operation_language, handler)`,
  where `handler` is any
  `Fn(serde_json::Value) -> serde_json::Value + Send + Sync`.

Rust can't load a function from a source file at runtime, so actors are linked
into the worker binary. If an actor function is missing or has the wrong
signature, the worker fails to compile instead of failing at startup.

A handler that panics is reported to the gateway as an `INTERNAL` invoke error
(the worker keeps running); an invoke for an unregistered actor is reported as
`NOT_FOUND`.

Logging goes through the [`log`](https://crates.io/crates/log) facade; the
library never installs a logger itself. The generated `main.rs` uses
`env_logger`, so `RUST_LOG=debug` raises the level.

## Releasing (maintainers)

Released from the [pgfsm/fsm](https://github.com/pgfsm/fsm) monorepo by
`.github/workflows/crates-publish.yml`. Pushing an
`async-worker-sdk-rs-v<version>` tag publishes to crates.io. This crate releases
independently of
[`pgfsm-proto-codegen`](https://crates.io/crates/pgfsm-proto-codegen).

1. **Pick the version.** While below 1.0: breaking API change → minor (`0.1.0` →
   `0.2.0`); new backward-compatible features → minor; fixes only → patch
   (`0.1.0` → `0.1.1`).
2. **Bump it in a PR.** Set `version` in `Cargo.toml` and run
   `cargo update -p
   pgfsm-async-worker-sdk` so `Cargo.lock` matches; commit
   both. If the new version needs a newer `pgfsm-proto-codegen`, release that
   first, then raise the dependency here.
3. **Tag the merge commit and push the tag.** The tag must be exactly
   `async-worker-sdk-rs-v` + `Cargo.toml`'s `version`:

   ```bash
   git fetch origin
   git tag async-worker-sdk-rs-v0.2.0 origin/main
   git push origin async-worker-sdk-rs-v0.2.0
   ```

4. **Check the release.** `gh run list --workflow crates-publish.yml` shows the
   run, which checks the tag against `Cargo.toml`, runs the tests, and
   publishes. Then confirm https://crates.io/crates/pgfsm-async-worker-sdk lists
   the version.

A published version can never be re-uploaded. If a bad version ships, release
the next patch and yank the bad one:
`cargo yank --version 0.2.0 pgfsm-async-worker-sdk`.

## License

Apache-2.0
