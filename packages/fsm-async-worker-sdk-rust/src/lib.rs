//! Rust worker SDK for the pgfsm Activity Gateway (`pgfsm-async-worker-sdk`).
//!
//! A worker process built on it connects to the gateway's sidecar (over its Unix
//! socket, or over TCP with TLS, a bearer token and/or mutual TLS), registers a
//! set of actors, and serves the invocations the gateway routes to them over
//! the `pgfsm.sidecargateway.v1.SidecarGatewayService` gRPC stream.
//! It never opens a database connection — that stays in the gateway.
//!
//! You normally don't write against this crate directly: `@pgfsm/compiler`'s
//! `generate-async-logic` writes a small `src/main.rs` that maps the project's
//! generated actor registry into [`ActorRegistration`]s and calls
//! [`run_actor_worker_cli`].
//!
//! ```no_run
//! use pgfsm_async_worker_sdk::{run_actor_worker_cli, ActorRegistration};
//!
//! fn check_bureau(input: serde_json::Value) -> serde_json::Value {
//!     serde_json::json!({ "input": input })
//! }
//!
//! fn main() {
//!     let registrations = vec![ActorRegistration::new(
//!         "creditCheck", "v01", "internalAsyncOperation", "checkBureau", "v01", "rust",
//!         check_bureau,
//!     )];
//!     std::process::exit(run_actor_worker_cli(registrations, std::env::args().skip(1), None));
//! }
//! ```

mod actor_worker;
mod cli;

pub use actor_worker::{
    actor_key, effective_max_concurrency, parse_gateway_address, reconnect_delay_ms, ActorHandler,
    ActorRegistration, ActorWorker, ActorWorkerOptions, BoxError, GatewayAddress,
    RegistrationRejectedError, DEFAULT_HEARTBEAT_MS, DEFAULT_KEEPALIVE_INTERVAL_MS,
    DEFAULT_KEEPALIVE_TIMEOUT_MS, DEFAULT_RECONNECT_INITIAL_DELAY_MS,
    DEFAULT_RECONNECT_MAX_DELAY_MS, DEFAULT_SHUTDOWN_GRACE_MS, FATAL_CODES, STABLE_SESSION_MS,
};
pub use cli::{env_var_for, run_actor_worker_cli, DEFAULT_GATEWAY_SOCKET_PATH, ENV_OPTIONS};
/// The generated protocol message an [`ActorRegistration`]'s `meta` is.
pub use pgfsm_proto_codegen::pgfsm::sidecargateway::v1::RegisteredActor;
