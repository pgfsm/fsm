# pgfsm-async-worker-sdk

Rust worker SDK for the pgfsm Activity Gateway. A worker process built on it
connects to the gateway's sidecar (over its Unix socket, or over TCP with TLS, a
bearer token and/or mutual TLS), registers a set of actors, and serves the
invocations the gateway routes to them over the
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
# the gateway as its own Deployment: TLS + bearer token, 10 invokes at once
cargo run --release -- start \
  --gateway-address https://activity-gateway:7443 \
  --gateway-ca-file ca.crt --gateway-token-file token --max-concurrency 10
```

### Options

```
-g, --gateway-socket <path>   Sidecar socket to connect to (default: /tmp/pgfsm-activity-gateway-workers.sock)
-a, --gateway-address <addr>  Gateway sidecar address instead: unix:<path>, https://host:port,
                              or http://host:port (the gateway's --insecure-plaintext test mode)
    --gateway-ca-file <file>  PEM CA bundle to trust the gateway's TLS certificate (default: system roots)
    --gateway-token-file <file>
                              Bearer token sent as `authorization: Bearer`; re-read on every reconnect
    --gateway-cert-file <file>
    --gateway-key-file <file> Client certificate and key for mutual TLS
-c, --max-concurrency <n>     Invokes of each actor run at once, for actors without their own
                              max_concurrency (default: 1; see "Concurrency")
    --keepalive-interval-ms <ms>
                              HTTP/2 PING interval over TCP (default: 30000; 0 disables)
    --keepalive-timeout-ms <ms>
                              Reconnect when a PING goes unanswered this long (default: 10000)
    --shutdown-grace-ms <ms>  On SIGINT/SIGTERM, how long in-flight invokes get to finish (default: 25000)
-i, --worker-id <id>          Stable worker identity (default: rust-<random>)
    --heartbeat-ms <ms>       Heartbeat interval (default: 5000)
    --reconnect-initial-delay-ms <ms>
                              First reconnect backoff step (default: 250)
    --reconnect-max-delay-ms <ms>
                              Reconnect backoff cap (default: 30000)
    --reconnect-max-attempts <n>
                              Exit after n consecutive failed attempts (default: 0 = retry forever)
-h, --help                    Show this help message
```

Invalid flags (both `--gateway-socket` and `--gateway-address`, an unknown
address scheme, a certificate without its key, a missing credentials file, an
out-of-range or non-integer number) exit 1 before connecting.

`start` doesn't need the gateway to be up first: it retries the connection with
exponential backoff (full jitter, 250 ms doubling up to 30 s), and if a session
drops (e.g. the gateway restarts) it reconnects and re-registers on its own. A
session only resets the backoff once it has stayed up for 10 s, so a gateway
that accepts and immediately drops still gets backed off from. `start` ends with
exit code 1 only on what reconnecting can't fix: an explicit registration
rejection; a gRPC `UNAUTHENTICATED`, `PERMISSION_DENIED`, `UNIMPLEMENTED` or
`INVALID_ARGUMENT` (a misconfiguration, so it fails fast instead of retrying);
or `--reconnect-max-attempts` consecutive failed attempts. An invoke result that
can't be sent because its session ended is logged and dropped; the gateway has
already failed that invoke.

### Environment variables

Every option except `--help` can also be set through an environment variable:
`PGFSM_` + the long option name in upper case, with `-` as `_`. The names are
the same in all four worker SDKs (TypeScript, Python, Rust, Go).

| Flag                           | Variable                           |
| ------------------------------ | ---------------------------------- |
| `--gateway-socket`             | `PGFSM_GATEWAY_SOCKET`             |
| `--gateway-address`            | `PGFSM_GATEWAY_ADDRESS`            |
| `--gateway-ca-file`            | `PGFSM_GATEWAY_CA_FILE`            |
| `--gateway-token-file`         | `PGFSM_GATEWAY_TOKEN_FILE`         |
| `--gateway-cert-file`          | `PGFSM_GATEWAY_CERT_FILE`          |
| `--gateway-key-file`           | `PGFSM_GATEWAY_KEY_FILE`           |
| `--max-concurrency`            | `PGFSM_MAX_CONCURRENCY`            |
| `--keepalive-interval-ms`      | `PGFSM_KEEPALIVE_INTERVAL_MS`      |
| `--keepalive-timeout-ms`       | `PGFSM_KEEPALIVE_TIMEOUT_MS`       |
| `--shutdown-grace-ms`          | `PGFSM_SHUTDOWN_GRACE_MS`          |
| `--worker-id`                  | `PGFSM_WORKER_ID`                  |
| `--heartbeat-ms`               | `PGFSM_HEARTBEAT_MS`               |
| `--reconnect-initial-delay-ms` | `PGFSM_RECONNECT_INITIAL_DELAY_MS` |
| `--reconnect-max-delay-ms`     | `PGFSM_RECONNECT_MAX_DELAY_MS`     |
| `--reconnect-max-attempts`     | `PGFSM_RECONNECT_MAX_ATTEMPTS`     |

- **Precedence: flag → variable → default.** An empty variable counts as unset.
- `--gateway-socket` and `--gateway-address` count as one setting: a flag for
  either overrides both variables, and setting both variables is an error.
- Credentials stay **file paths** (`PGFSM_GATEWAY_TOKEN_FILE` names the token
  file, not the token), so secrets never sit in the environment.
- A bad value exits 1 before connecting, naming the variable.
- Variables are read from the process environment. The SDK doesn't load `.env`
  files itself; use `set -a; . ./.env; set +a` before `cargo run`, or a
  container's `env_file`.

### Connecting over TCP (SPEC-007)

When the gateway runs as its own Deployment, point workers at its Service with
`--gateway-address https://<service>:<port>`:

- **TLS.** `--gateway-ca-file` trusts the gateway's certificate; without it the
  system trust store is used. The gateway requires TLS 1.3 by default; this
  crate (rustls) supports it.
- **Bearer token.** `--gateway-token-file` sends the token the gateway checks
  (`--auth-token-file` there). It's re-read on every reconnect, so a rotated
  Secret is picked up without restarting the worker. A wrong token is
  `UNAUTHENTICATED`, which ends `start` with exit code 1.
- **Mutual TLS.** `--gateway-cert-file`/`--gateway-key-file` present a client
  certificate when the gateway requires one (`--tls-client-ca` there).
  Certificate files are also re-read on every reconnect.
- **Keepalive.** Over TCP the worker PINGs the gateway, so a half-open
  connection is noticed and the worker reconnects.
- **Rebalancing.** Every session uses a new connection. When the gateway drains
  the worker after its max connection age, the worker reconnects through the
  Service and may land on another gateway replica.

`http://host:port` is only for a gateway started with `--insecure-plaintext`
(local testing).

### Concurrency

By default each actor handles **one invoke at a time**. To run more, set:

- `--max-concurrency <n>` (or `max_concurrency` in `ActorWorkerOptions`): the
  worker-wide default for every actor;
- `.with_max_concurrency(n)` on an actor's `ActorRegistration`: that actor's own
  limit, which wins over the worker-wide one.

The effective limit per actor is **its own `max_concurrency`, else the worker's,
else 1**. It's sent to the gateway at registration, so the gateway claims and
routes no more than that, and the worker also enforces it locally: extra invokes
of an actor wait for a slot.

Handlers are synchronous, so each invoke runs on tokio's blocking thread pool
and may block (sleep, do blocking I/O, compute) without stalling the worker.
**Above 1, the same handler runs on several threads at once.** The compiler
already requires it to be `Send + Sync`, so shared state needs a `Mutex`,
atomics or similar; what it can't check is logic that assumes calls never
overlap (read-then-write on shared data, a resource that only one call may use
at a time). Keep per-invoke state local. CPU-bound handlers do scale across
cores here, up to the limit you set.

Separately from concurrency, **handlers must be idempotent**: delivery is
at-least-once, so an actor may run again for the same message (after a worker or
gateway restart, a dropped connection, or a timeout).

### Stopping

`stop()` (and SIGINT/SIGTERM under `run_actor_worker_cli`) drains: invokes that
arrive while stopping are refused with a retriable `WORKER_DRAINING` error, so
the gateway delivers them again to another worker, and in-flight invokes are
allowed to finish for up to `shutdown_grace_ms` (default 25 s; keep it below
your pod's termination grace period). Then the worker unregisters and
disconnects. `stop()` doesn't block (it's safe from any thread); `run()` returns
once the drain is over. A handler still running when the grace period ends can't
be stopped (Rust can't kill a thread): its result is dropped, and
`run_actor_worker_cli` returns without waiting for it, so the process exits.

## API

- `run_actor_worker_cli(registrations, args, invocation) -> i32`: the
  `list`/`start` CLI. Returns the process exit code instead of exiting. It
  builds its own tokio runtime, so call it from a plain (non-async) `main`.
- `ActorWorker::new(ActorWorkerOptions { worker_id, gateway_address, ..Default::default() }, registrations)`:
  `run().await` registers every actor and serves invocations until `stop()` is
  called, reconnecting and re-registering whenever a session drops. Pass
  `gateway_address: Some("https://host:port".into())` (plus `ca_file`,
  `token_file`, `cert_file`/`key_file` as needed), or set `gateway_socket_path`
  for a Unix socket. The other options (`max_concurrency`, `shutdown_grace_ms`,
  `keepalive_interval_ms`, `keepalive_timeout_ms`, `heartbeat_ms`,
  `reconnect_initial_delay_ms`, `reconnect_max_delay_ms`,
  `reconnect_max_attempts`) default via `ActorWorkerOptions::default()`. It
  returns `RegistrationRejectedError` on an explicit rejection, a
  `tonic::Status` on a fatal gRPC code, or an error for an invalid address or
  after `reconnect_max_attempts` consecutive failed attempts.
- `ActorRegistration::new(parent_fsm_name, parent_fsm_version, async_operation_type, async_operation_name, async_operation_version, async_operation_language, handler)`,
  where `handler` is any
  `Fn(serde_json::Value) -> serde_json::Value + Send + Sync`, optionally
  followed by `.with_max_concurrency(n)`.
- `parse_gateway_address(address)` and
  `effective_max_concurrency(actor_max, worker_max)`: the helpers the worker and
  CLI use.

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
