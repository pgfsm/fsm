//! `ActorWorker` — moved here from fsm-compiler-ts's `rust/worker-sdk-sdk.eta`
//! (#368), which used to write this whole file into every project as
//! `async-worker/rust/src/sdk.rs`.
//!
//! Connects to the gateway's sidecar Unix socket via the generated
//! `pgfsm.sidecargateway.v1.SidecarGatewayService` bidi-streaming client (the
//! `pgfsm-proto-codegen` crate), registers a compiled-in actor registry, and
//! serves invoke requests.
//!
//! Unlike the TypeScript and Python SDKs, there's no dynamic loading step:
//! Rust has no runtime mechanism to load a function out of a `.rs` source file
//! the way `import()` or `importlib` can. `ActorWorker` takes an explicit
//! `Vec<ActorRegistration>` built by the binary that uses it (the generated
//! worker's `main.rs`), so the actor functions are linked into that binary and
//! "verification" happens at compile time.
//!
//! Outgoing messages (register, heartbeat, invoke_result, invoke_error,
//! unregister) are pushed onto a `tokio::sync::mpsc::UnboundedSender` whose
//! receiver, wrapped in an `UnboundedReceiverStream`, is tonic's request
//! stream — the Rust analogue of the TypeScript SDK's push-based AsyncQueue
//! and the Python SDK's queue-backed generator. Dropping the sender ends the
//! stream, which is how `stop()` (a plain sync method, safe to call from a
//! signal handler) shuts things down without an async context.

use pgfsm_proto_codegen::pgfsm::sidecargateway::v1::sidecar_gateway_service_client::SidecarGatewayServiceClient;
use pgfsm_proto_codegen::pgfsm::sidecargateway::v1::{
    session_request, session_response, Heartbeat, Invoke, InvokeError, InvokeErrorDetail,
    InvokeResult, Register, RegisteredActor, SessionRequest, SessionResponse, Unregister,
};
use serde_json::Value;
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_stream::StreamExt;
use tonic::codec::Streaming;

/// Default heartbeat interval, in milliseconds.
pub const DEFAULT_HEARTBEAT_MS: u64 = 5000;

/// Error type returned by [`ActorWorker::run`].
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// An actor's compiled-in implementation. Panics are caught by the SDK and
/// reported to the gateway as an `INTERNAL` invoke error rather than crashing
/// the worker process — the Rust equivalent of a thrown exception in the
/// TypeScript/Python SDKs.
pub type ActorHandler = Box<dyn Fn(Value) -> Value + Send + Sync>;

/// One actor to register with the gateway: its identity (`meta`, the same
/// `RegisteredActor` message the gateway receives) and its handler.
pub struct ActorRegistration {
    pub meta: RegisteredActor,
    pub handler: ActorHandler,
}

impl ActorRegistration {
    /// Builds a registration from the six identity fields the compiler's
    /// generated registry carries, plus the handler.
    pub fn new(
        parent_fsm_name: &str,
        parent_fsm_version: &str,
        async_operation_type: &str,
        async_operation_name: &str,
        async_operation_version: &str,
        async_operation_language: &str,
        handler: impl Fn(Value) -> Value + Send + Sync + 'static,
    ) -> Self {
        Self {
            meta: RegisteredActor {
                parent_fsm_name: parent_fsm_name.to_string(),
                parent_fsm_version: parent_fsm_version.to_string(),
                async_operation_type: async_operation_type.to_string(),
                async_operation_name: async_operation_name.to_string(),
                async_operation_version: async_operation_version.to_string(),
                async_operation_language: async_operation_language.to_string(),
                ..Default::default()
            },
            handler: Box::new(handler),
        }
    }
}

pub struct ActorWorkerOptions {
    pub worker_id: String,
    pub gateway_socket_path: String,
    pub heartbeat_ms: u64,
}

/// The key the gateway's invoke fields are matched against: all six identity
/// fields joined with `@`, same as the TypeScript and Python SDKs.
pub fn actor_key(
    parent_fsm_name: &str,
    parent_fsm_version: &str,
    async_operation_type: &str,
    async_operation_name: &str,
    async_operation_version: &str,
    async_operation_language: &str,
) -> String {
    format!(
        "{}@{}@{}@{}@{}@{}",
        parent_fsm_name,
        parent_fsm_version,
        async_operation_type,
        async_operation_name,
        async_operation_version,
        async_operation_language
    )
}

pub struct ActorWorker {
    options: ActorWorkerOptions,
    handlers: HashMap<String, ActorHandler>,
    registered: Vec<RegisteredActor>,
    stopped: Arc<AtomicBool>,
    outbox: Mutex<Option<mpsc::UnboundedSender<SessionRequest>>>,
}

impl ActorWorker {
    pub fn new(options: ActorWorkerOptions, registrations: Vec<ActorRegistration>) -> Self {
        let mut handlers = HashMap::new();
        let mut registered = Vec::with_capacity(registrations.len());
        for reg in registrations {
            let key = actor_key(
                &reg.meta.parent_fsm_name,
                &reg.meta.parent_fsm_version,
                &reg.meta.async_operation_type,
                &reg.meta.async_operation_name,
                &reg.meta.async_operation_version,
                &reg.meta.async_operation_language,
            );
            handlers.insert(key, reg.handler);
            registered.push(reg.meta);
        }
        Self {
            options,
            handlers,
            registered,
            stopped: Arc::new(AtomicBool::new(false)),
            outbox: Mutex::new(None),
        }
    }

    /// The actors this worker registers, in registration order.
    pub fn registered_actors(&self) -> &[RegisteredActor] {
        &self.registered
    }

    /// Registers every actor and serves invocations until [`stop`](Self::stop)
    /// is called or the gateway ends the stream. The gRPC channel is dropped
    /// (closed) before this returns.
    pub async fn run(&self) -> Result<(), BoxError> {
        if self.registered.is_empty() {
            return Err("no actors to register, refusing to start worker".into());
        }
        if self.stopped.load(Ordering::SeqCst) {
            return Ok(());
        }

        let endpoint = tonic::transport::Endpoint::from_shared(format!(
            "unix://{}",
            self.options.gateway_socket_path
        ))?;
        let channel = endpoint.connect().await?;
        let mut client = SidecarGatewayServiceClient::new(channel);

        let (tx, rx) = mpsc::unbounded_channel::<SessionRequest>();
        tx.send(SessionRequest {
            payload: Some(session_request::Payload::Register(Register {
                worker_id: self.options.worker_id.clone(),
                language: "rust".to_string(),
                protocol_version: "1.0".to_string(),
                actors: self.registered.clone(),
            })),
        })?;
        let heartbeat_tx = tx.clone();
        *self.outbox.lock().unwrap() = Some(tx);

        let outbound = UnboundedReceiverStream::new(rx);
        let response = client.session(outbound).await?;
        let mut inbound = response.into_inner();

        let first = inbound
            .next()
            .await
            .ok_or("expected register_ack but got EOF")??;
        let register_ack = match first.payload {
            Some(session_response::Payload::RegisterAck(ack)) => ack,
            other => return Err(format!("expected register_ack but got {:?}", other).into()),
        };
        if !register_ack.accepted {
            self.stopped.store(true, Ordering::SeqCst);
            self.close_outbox(None);
            return Err("gateway rejected registration".into());
        }

        log::info!(
            "Worker {} registered {} actor(s) with the gateway",
            self.options.worker_id,
            self.registered.len()
        );

        let heartbeat_handle = {
            let stopped = self.stopped.clone();
            let worker_id = self.options.worker_id.clone();
            let heartbeat_ms = self.options.heartbeat_ms;
            tokio::spawn(async move {
                while !stopped.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(heartbeat_ms)).await;
                    if stopped.load(Ordering::SeqCst) {
                        break;
                    }
                    let msg = SessionRequest {
                        payload: Some(session_request::Payload::Heartbeat(Heartbeat {
                            worker_id: worker_id.clone(),
                        })),
                    };
                    if heartbeat_tx.send(msg).is_err() {
                        break;
                    }
                }
            })
        };

        let serve_result = self.serve_loop(&mut inbound).await;

        self.stopped.store(true, Ordering::SeqCst);
        heartbeat_handle.abort();
        self.close_outbox(None);

        serve_result
    }

    /// Asks the gateway to unregister this worker and ends the session. Safe to
    /// call from any thread (including a signal handler) and more than once.
    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        self.close_outbox(Some(SessionRequest {
            payload: Some(session_request::Payload::Unregister(Unregister {
                worker_id: self.options.worker_id.clone(),
            })),
        }));
    }

    /// Sends `final_message` (if any) and drops the stored sender — dropping
    /// the last `UnboundedSender` ends the `UnboundedReceiverStream` tonic is
    /// reading the request stream from, which is how a Rust client ends its
    /// side of a bidi call.
    fn close_outbox(&self, final_message: Option<SessionRequest>) {
        let mut guard = self.outbox.lock().unwrap();
        if let Some(tx) = guard.take() {
            if let Some(msg) = final_message {
                let _ = tx.send(msg);
            }
        }
    }

    fn push(&self, msg: SessionRequest) {
        if let Some(tx) = self.outbox.lock().unwrap().as_ref() {
            let _ = tx.send(msg);
        }
    }

    async fn serve_loop(&self, inbound: &mut Streaming<SessionResponse>) -> Result<(), BoxError> {
        while !self.stopped.load(Ordering::SeqCst) {
            let response = match inbound.next().await {
                Some(Ok(r)) => r,
                Some(Err(status)) => {
                    // After stop() the gateway may close the stream with a
                    // status rather than a clean EOF; that's a normal shutdown.
                    if self.stopped.load(Ordering::SeqCst) {
                        break;
                    }
                    return Err(Box::new(status));
                }
                None => break,
            };

            match response.payload {
                Some(session_response::Payload::Cancel(_)) => continue,
                Some(session_response::Payload::Invoke(invoke)) => self.handle_invoke(invoke),
                _ => continue,
            }
        }
        Ok(())
    }

    fn handle_invoke(&self, body: Invoke) {
        let key = actor_key(
            &body.parent_fsm_name,
            &body.parent_fsm_version,
            &body.async_operation_type,
            &body.async_operation_name,
            &body.async_operation_version,
            &body.async_operation_language,
        );

        let handler = match self.handlers.get(&key) {
            Some(h) => h,
            None => {
                log::warn!("Invoke {} for unknown actor {}", body.invoke_id, key);
                self.send_error(
                    &body.invoke_id,
                    "NOT_FOUND",
                    &format!("actor not found: {}", key),
                );
                return;
            }
        };

        let input: Value = if body.input_json.trim().is_empty() {
            Value::Null
        } else {
            match serde_json::from_str(&body.input_json) {
                Ok(v) => v,
                Err(e) => {
                    self.send_error(
                        &body.invoke_id,
                        "INTERNAL",
                        &format!("invalid input_json: {}", e),
                    );
                    return;
                }
            }
        };

        let started = Instant::now();
        match catch_unwind(AssertUnwindSafe(|| handler(input))) {
            Ok(output) => {
                let output_json =
                    serde_json::to_string(&output).unwrap_or_else(|_| "null".to_string());
                let duration_ms = started.elapsed().as_millis().min(u32::MAX as u128) as u32;
                self.push(SessionRequest {
                    payload: Some(session_request::Payload::InvokeResult(InvokeResult {
                        invoke_id: body.invoke_id,
                        output_json,
                        duration_ms,
                    })),
                });
            }
            Err(panic_payload) => {
                let message = panic_message(&panic_payload);
                log::error!("Actor {} panicked: {}", key, message);
                self.send_error(&body.invoke_id, "INTERNAL", &message);
            }
        }
    }

    fn send_error(&self, invoke_id: &str, code: &str, message: &str) {
        self.push(SessionRequest {
            payload: Some(session_request::Payload::InvokeError(InvokeError {
                invoke_id: invoke_id.to_string(),
                error: Some(InvokeErrorDetail {
                    code: code.to_string(),
                    message: message.to_string(),
                    retriable: false,
                }),
                duration_ms: 0,
            })),
        });
    }
}

fn panic_message(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "actor panicked".to_string()
    }
}
