//! Rust worker SDK for the pgfsm Activity Gateway (`pgfsm-async-worker-sdk`).
//!
//! A worker process built on it connects to the gateway's sidecar Unix socket,
//! registers a set of actors, and serves the invocations the gateway routes to
//! them over the `pgfsm.sidecargateway.v1.SidecarGatewayService` gRPC stream.
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
    actor_key, ActorHandler, ActorRegistration, ActorWorker, ActorWorkerOptions, BoxError,
    DEFAULT_HEARTBEAT_MS,
};
pub use cli::{run_actor_worker_cli, DEFAULT_GATEWAY_SOCKET_PATH};
/// The generated protocol message an [`ActorRegistration`]'s `meta` is.
pub use pgfsm_proto_codegen::pgfsm::sidecargateway::v1::RegisteredActor;
