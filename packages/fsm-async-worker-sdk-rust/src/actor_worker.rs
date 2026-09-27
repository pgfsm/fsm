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
use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Notify};
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_stream::StreamExt;
use tonic::codec::Streaming;

/// Default heartbeat interval, in milliseconds.
pub const DEFAULT_HEARTBEAT_MS: u64 = 5000;
/// Default first reconnect backoff step, in milliseconds (#392).
pub const DEFAULT_RECONNECT_INITIAL_DELAY_MS: u64 = 250;
/// Default reconnect backoff cap, in milliseconds (#392).
pub const DEFAULT_RECONNECT_MAX_DELAY_MS: u64 = 30000;

/// How long a session must stay up before the reconnect backoff resets, so a
/// gateway that accepts and immediately drops (flapping) still backs off
/// instead of being hammered in a tight loop.
pub const STABLE_SESSION_MS: u64 = 10000;

/// gRPC codes that reconnecting can't fix (bad credentials, wrong server or
/// protocol): `run` fails fast on these rather than retrying forever and
/// hiding a misconfiguration behind warnings. Same list in all four SDKs.
pub const FATAL_CODES: [tonic::Code; 4] = [
    tonic::Code::Unauthenticated,
    tonic::Code::PermissionDenied,
    tonic::Code::Unimplemented,
    tonic::Code::InvalidArgument,
];

fn is_fatal(err: &BoxError) -> bool {
    err.is::<RegistrationRejectedError>()
        || err
            .downcast_ref::<tonic::Status>()
            .is_some_and(|status| FATAL_CODES.contains(&status.code()))
}

/// The gateway explicitly refused this worker's registration.
/// [`ActorWorker::run`] returns it instead of retrying, since reconnecting
/// would just be refused again.
#[derive(Debug)]
pub struct RegistrationRejectedError;

impl std::fmt::Display for RegistrationRejectedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("gateway rejected registration")
    }
}

impl std::error::Error for RegistrationRejectedError {}

/// Full-jitter exponential backoff: a random delay in
/// `[0, min(max_ms, initial_ms * 2^(attempt-1)))`. Same formula in all four
/// SDKs.
pub fn reconnect_delay_ms(attempt: u32, initial_ms: u64, max_ms: u64) -> u64 {
    let exponent = attempt.max(1) - 1;
    let ceiling = initial_ms
        .saturating_mul(2u64.saturating_pow(exponent))
        .min(max_ms);
    (random_fraction() * ceiling as f64) as u64
}

/// A uniform random value in `[0, 1)` from std's randomly-keyed SipHash —
/// enough for backoff jitter without pulling in a `rand` dependency.
fn random_fraction() -> f64 {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default(),
    );
    (hasher.finish() >> 11) as f64 / (1u64 << 53) as f64
}

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
    /// First reconnect backoff step.
    pub reconnect_initial_delay_ms: u64,
    /// Reconnect backoff cap.
    pub reconnect_max_delay_ms: u64,
    /// Give up after this many consecutive failed attempts; 0 retries forever.
    /// A session that fails to register, or registers but ends within
    /// [`STABLE_SESSION_MS`], counts as a failed attempt; a longer one resets
    /// the count.
    pub reconnect_max_attempts: u32,
}

impl Default for ActorWorkerOptions {
    fn default() -> Self {
        Self {
            worker_id: String::new(),
            gateway_socket_path: crate::cli::DEFAULT_GATEWAY_SOCKET_PATH.to_string(),
            heartbeat_ms: DEFAULT_HEARTBEAT_MS,
            reconnect_initial_delay_ms: DEFAULT_RECONNECT_INITIAL_DELAY_MS,
            reconnect_max_delay_ms: DEFAULT_RECONNECT_MAX_DELAY_MS,
            reconnect_max_attempts: 0,
        }
    }
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
    /// Signalled by `stop()` to cut a reconnect backoff short.
    stop_notify: Notify,
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
            stop_notify: Notify::new(),
            outbox: Mutex::new(None),
        }
    }

    /// The actors this worker registers, in registration order.
    pub fn registered_actors(&self) -> &[RegisteredActor] {
        &self.registered
    }

    /// Registers every actor and serves invocations until [`stop`](Self::stop)
    /// is called. If the gateway isn't up yet, or a session ends (gateway
    /// restart, dropped connection), reconnects with backoff and re-registers
    /// (#392). Returns an error only for what reconnecting can't fix: an empty
    /// registry, [`RegistrationRejectedError`], or `reconnect_max_attempts`
    /// consecutive failed attempts.
    pub async fn run(&self) -> Result<(), BoxError> {
        if self.registered.is_empty() {
            return Err("no actors to register, refusing to start worker".into());
        }

        let mut failures: u32 = 0;
        while !self.stopped.load(Ordering::SeqCst) {
            let mut registered = false;
            let started = Instant::now();
            let result = self.run_session(&mut registered).await;
            if let Err(err) = &result {
                if is_fatal(err) {
                    return result;
                }
            }
            if self.stopped.load(Ordering::SeqCst) {
                break;
            }

            let stable =
                registered && started.elapsed() >= Duration::from_millis(STABLE_SESSION_MS);
            failures = if stable { 0 } else { failures + 1 };
            let reason = match &result {
                Err(err) => err.to_string(),
                Ok(()) => "stream closed".to_string(),
            };
            let max_attempts = self.options.reconnect_max_attempts;
            if max_attempts > 0 && failures >= max_attempts {
                return Err(format!(
                    "giving up after {} consecutive failed attempt(s) to connect to the gateway: {}",
                    failures, reason
                )
                .into());
            }

            let delay_ms = reconnect_delay_ms(
                failures.max(1),
                self.options.reconnect_initial_delay_ms,
                self.options.reconnect_max_delay_ms,
            );
            if registered {
                log::warn!(
                    "Gateway session ended ({}); reconnecting in {}ms",
                    reason,
                    delay_ms
                );
            } else {
                log::warn!(
                    "Could not connect to the gateway ({}); retrying in {}ms",
                    reason,
                    delay_ms
                );
            }
            tokio::select! {
                _ = self.stop_notify.notified() => break,
                _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => {}
            }
        }
        Ok(())
    }

    /// One connect → register → serve cycle. Sets `registered` once the
    /// gateway acks; `run` resets the backoff only if a registered session also
    /// lasted [`STABLE_SESSION_MS`]. The gRPC channel
    /// is dropped (closed) before this returns.
    async fn run_session(&self, registered: &mut bool) -> Result<(), BoxError> {
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
        // stop() may have run before the sender was stored above, in which
        // case it had nothing to unregister on.
        if self.stopped.load(Ordering::SeqCst) {
            self.close_outbox(None);
            return Ok(());
        }

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
            self.close_outbox(None);
            return Err(Box::new(RegistrationRejectedError));
        }
        *registered = true;

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
        // notify_one stores a permit if run() isn't waiting yet, so a stop
        // racing the start of a backoff still cuts it short.
        self.stop_notify.notify_one();
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

    /// Sends on the current session; false if there is none (it ended).
    fn push(&self, msg: SessionRequest) -> bool {
        match self.outbox.lock().unwrap().as_ref() {
            Some(tx) => tx.send(msg).is_ok(),
            None => false,
        }
    }

    /// Pushes an invoke's result or error. If the invoke outlived its session
    /// the result can't go out on a later one (the gateway matches results to
    /// the connection it sent the invoke on, and has already failed it as
    /// WORKER_DISCONNECTED), so log instead of dropping it silently.
    fn push_result(&self, msg: SessionRequest, invoke_id: &str) {
        if !self.push(msg) {
            log::warn!(
                "Dropping result of invoke {}: its gateway session ended",
                invoke_id
            );
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
                self.push_result(
                    SessionRequest {
                        payload: Some(session_request::Payload::InvokeResult(InvokeResult {
                            invoke_id: body.invoke_id.clone(),
                            output_json,
                            duration_ms,
                        })),
                    },
                    &body.invoke_id,
                );
            }
            Err(panic_payload) => {
                let message = panic_message(&panic_payload);
                log::error!("Actor {} panicked: {}", key, message);
                self.send_error(&body.invoke_id, "INTERNAL", &message);
            }
        }
    }

    fn send_error(&self, invoke_id: &str, code: &str, message: &str) {
        self.push_result(
            SessionRequest {
                payload: Some(session_request::Payload::InvokeError(InvokeError {
                    invoke_id: invoke_id.to_string(),
                    error: Some(InvokeErrorDetail {
                        code: code.to_string(),
                        message: message.to_string(),
                        retriable: false,
                    }),
                    duration_ms: 0,
                })),
            },
            invoke_id,
        );
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
