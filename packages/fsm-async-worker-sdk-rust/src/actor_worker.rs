//! `ActorWorker` — moved here from fsm-compiler-ts's `rust/worker-sdk-sdk.eta`
//! (#368), which used to write this whole file into every project as
//! `async-worker/rust/src/sdk.rs`.
//!
//! Connects to the gateway's sidecar, over its Unix socket or over TCP (TLS,
//! bearer token and/or mutual TLS — SPEC-007), via the generated
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
//! unregister) are pushed onto a per-session `tokio::sync::mpsc::UnboundedSender`
//! whose receiver, wrapped in an `UnboundedReceiverStream`, is tonic's request
//! stream — the Rust analogue of the TypeScript SDK's push-based AsyncQueue
//! and the Python SDK's queue-backed generator. Dropping the sender ends the
//! stream. `stop()` is a plain sync method (safe from any thread); it flips a
//! `watch` flag that the serve loop and the reconnect backoff wait on, and the
//! drain runs inside `run()`.

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
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch, Semaphore};
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_stream::StreamExt;
use tonic::codec::Streaming;
use tonic::metadata::{Ascii, MetadataValue};
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Endpoint, Identity};

/// Default heartbeat interval, in milliseconds.
pub const DEFAULT_HEARTBEAT_MS: u64 = 5000;
/// Default first reconnect backoff step, in milliseconds (#392).
pub const DEFAULT_RECONNECT_INITIAL_DELAY_MS: u64 = 250;
/// Default reconnect backoff cap, in milliseconds (#392).
pub const DEFAULT_RECONNECT_MAX_DELAY_MS: u64 = 30000;
/// Default HTTP/2 PING interval on TCP connections, in milliseconds.
pub const DEFAULT_KEEPALIVE_INTERVAL_MS: u64 = 30000;
/// Default time to wait for a PING ack before dropping the connection.
pub const DEFAULT_KEEPALIVE_TIMEOUT_MS: u64 = 10000;
/// Default time in-flight invokes get to finish after `stop()`.
pub const DEFAULT_SHUTDOWN_GRACE_MS: u64 = 25000;

/// After the drain the worker ends its request stream and waits this long for
/// the gateway to end its side, so the unregister is flushed before the
/// connection drops.
const CLOSE_WAIT: Duration = Duration::from_secs(5);

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

    /// Sets how many invokes of this actor run at once, overriding the
    /// worker's `max_concurrency`; 0 (the default) falls back to it, then to 1
    /// (SPEC-007). The handler must be safe to run concurrently above 1.
    pub fn with_max_concurrency(mut self, max_concurrency: u32) -> Self {
        self.meta.max_concurrency = max_concurrency;
        self
    }
}

/// A parsed gateway address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GatewayAddress {
    /// `unix:<path>`.
    Unix { path: String },
    /// `https://host:port` (`tls`) or `http://host:port`; `url` has no
    /// trailing slash.
    Tcp { url: String, tls: bool },
}

/// Parses `unix:<path>`, `https://host:port` or `http://host:port`.
pub fn parse_gateway_address(address: &str) -> Result<GatewayAddress, String> {
    if let Some(path) = address.strip_prefix("unix:") {
        if !path.is_empty() {
            return Ok(GatewayAddress::Unix {
                path: path.to_string(),
            });
        }
    }
    for (scheme, tls) in [("https://", true), ("http://", false)] {
        let Some(rest) = address.strip_prefix(scheme) else {
            continue;
        };
        let rest = rest.strip_suffix('/').unwrap_or(rest);
        if let Some((host, port)) = rest.rsplit_once(':') {
            if !host.is_empty()
                && !host.contains('/')
                && !port.is_empty()
                && port.bytes().all(|b| b.is_ascii_digit())
            {
                return Ok(GatewayAddress::Tcp {
                    url: format!("{}{}", scheme, rest),
                    tls,
                });
            }
        }
    }
    Err(format!(
        "gateway address must be unix:<path>, https://host:port or http://host:port, got: {}",
        address
    ))
}

/// The limit an actor runs under: its own, else the worker's, else 1. 0 means
/// unset for both.
pub fn effective_max_concurrency(actor_max: u32, worker_max: u32) -> u32 {
    [actor_max, worker_max]
        .into_iter()
        .find(|&n| n > 0)
        .unwrap_or(1)
}

pub struct ActorWorkerOptions {
    pub worker_id: String,
    /// Shorthand for `gateway_address: Some("unix:<path>")`.
    pub gateway_socket_path: String,
    /// Where the gateway's sidecar listens: `unix:<path>`, `https://host:port`
    /// (TLS), or `http://host:port` (the gateway's --insecure-plaintext test
    /// mode). Takes precedence over `gateway_socket_path`.
    pub gateway_address: Option<String>,
    /// PEM CA bundle to trust the gateway's TLS certificate (default: the
    /// system roots).
    pub ca_file: Option<PathBuf>,
    /// File holding the bearer token sent as `authorization: Bearer <token>`.
    /// Re-read for every session, so a rotated Secret is picked up on
    /// reconnect.
    pub token_file: Option<PathBuf>,
    /// PEM client certificate and key for mutual TLS; re-read for every
    /// session.
    pub cert_file: Option<PathBuf>,
    pub key_file: Option<PathBuf>,
    /// HTTP/2 PING interval on TCP connections; a PING unanswered for
    /// `keepalive_timeout_ms` drops the session so the worker reconnects. 0
    /// disables. Not used for Unix sockets.
    pub keepalive_interval_ms: u64,
    pub keepalive_timeout_ms: u64,
    /// Invokes of each actor run at once, for actors without their own
    /// `max_concurrency`. 0 (the default) means 1: one at a time, the
    /// historical behaviour.
    pub max_concurrency: u32,
    /// After `stop()`, how long in-flight invokes get to finish before the
    /// worker disconnects anyway.
    pub shutdown_grace_ms: u64,
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
            gateway_address: None,
            ca_file: None,
            token_file: None,
            cert_file: None,
            key_file: None,
            keepalive_interval_ms: DEFAULT_KEEPALIVE_INTERVAL_MS,
            keepalive_timeout_ms: DEFAULT_KEEPALIVE_TIMEOUT_MS,
            max_concurrency: 0,
            shutdown_grace_ms: DEFAULT_SHUTDOWN_GRACE_MS,
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

/// One session's outgoing stream. Invoke tasks hold an `Arc` of it rather
/// than a sender clone, so closing it (taking the sender) still ends the
/// request stream while they run, and a result that outlives its session is
/// detected instead of going out on a later one.
struct SessionOutbox {
    tx: Mutex<Option<mpsc::UnboundedSender<SessionRequest>>>,
}

impl SessionOutbox {
    /// Sends on this session; false once it's closed.
    fn send(&self, msg: SessionRequest) -> bool {
        match self.tx.lock().unwrap().as_ref() {
            Some(tx) => tx.send(msg).is_ok(),
            None => false,
        }
    }

    /// Sends `final_message` (if any) and drops the sender — dropping it ends
    /// the `UnboundedReceiverStream` tonic reads the request stream from,
    /// which is how a Rust client ends its side of a bidi call.
    fn close(&self, final_message: Option<SessionRequest>) {
        if let Some(tx) = self.tx.lock().unwrap().take() {
            if let Some(msg) = final_message {
                let _ = tx.send(msg);
            }
        }
    }
}

/// Counts one invoke as in flight for as long as it lives.
struct InFlight(Arc<watch::Sender<usize>>);

impl InFlight {
    fn new(counter: Arc<watch::Sender<usize>>) -> Self {
        counter.send_modify(|n| *n += 1);
        Self(counter)
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.send_modify(|n| *n -= 1);
    }
}

/// Connects to the gateway's sidecar, registers its actors, and serves invoke
/// requests until [`stop`](Self::stop). If the gateway isn't up yet, or a
/// session ends (gateway restart, dropped connection, max connection age), it
/// reconnects with backoff on a new connection and re-registers (#392).
///
/// Invokes run concurrently, each handler on tokio's blocking pool, up to each
/// actor's limit (its own `max_concurrency`, else the worker's, else 1); extra
/// invokes of an actor wait for a slot. `stop()` drains: new invokes are
/// refused as retriable (`WORKER_DRAINING`, so the gateway delivers them again
/// elsewhere) while in-flight ones finish, up to `shutdown_grace_ms`.
pub struct ActorWorker {
    options: ActorWorkerOptions,
    address: Result<GatewayAddress, String>,
    handlers: HashMap<String, Arc<ActorHandler>>,
    slots: HashMap<String, Arc<Semaphore>>,
    registered: Vec<RegisteredActor>,
    stop_requested: AtomicBool,
    /// Flipped to true by `stop()`; the serve loop and the reconnect backoff
    /// wait on it.
    stopping: watch::Sender<bool>,
    /// When the drain gives up on in-flight invokes; set by `stop()`.
    drain_deadline: Mutex<Option<Instant>>,
    in_flight: Arc<watch::Sender<usize>>,
}

impl ActorWorker {
    pub fn new(options: ActorWorkerOptions, registrations: Vec<ActorRegistration>) -> Self {
        let address = match &options.gateway_address {
            Some(address) => parse_gateway_address(address),
            None => parse_gateway_address(&format!("unix:{}", options.gateway_socket_path)),
        };
        let mut handlers = HashMap::new();
        let mut slots = HashMap::new();
        let mut registered = Vec::with_capacity(registrations.len());
        for mut reg in registrations {
            let key = actor_key(
                &reg.meta.parent_fsm_name,
                &reg.meta.parent_fsm_version,
                &reg.meta.async_operation_type,
                &reg.meta.async_operation_name,
                &reg.meta.async_operation_version,
                &reg.meta.async_operation_language,
            );
            reg.meta.max_concurrency =
                effective_max_concurrency(reg.meta.max_concurrency, options.max_concurrency);
            slots.insert(
                key.clone(),
                Arc::new(Semaphore::new(reg.meta.max_concurrency as usize)),
            );
            handlers.insert(key, Arc::new(reg.handler));
            registered.push(reg.meta);
        }
        Self {
            options,
            address,
            handlers,
            slots,
            registered,
            stop_requested: AtomicBool::new(false),
            stopping: watch::channel(false).0,
            drain_deadline: Mutex::new(None),
            in_flight: Arc::new(watch::channel(0).0),
        }
    }

    /// The actors this worker registers, in registration order, each with the
    /// effective `max_concurrency` it declares to the gateway.
    pub fn registered_actors(&self) -> &[RegisteredActor] {
        &self.registered
    }

    fn is_stopping(&self) -> bool {
        *self.stopping.borrow()
    }

    /// Registers every actor and serves invocations until [`stop`](Self::stop)
    /// is called, then returns once the drain is over. Returns an error only
    /// for what reconnecting can't fix: an empty registry, an invalid gateway
    /// address, [`RegistrationRejectedError`], a fatal gRPC code (see
    /// [`FATAL_CODES`]), or `reconnect_max_attempts` consecutive failed
    /// attempts.
    pub async fn run(&self) -> Result<(), BoxError> {
        if self.registered.is_empty() {
            return Err("no actors to register, refusing to start worker".into());
        }
        let address = self.address.clone()?;
        let mut stop_rx = self.stopping.subscribe();

        let mut failures: u32 = 0;
        while !self.is_stopping() {
            let mut registered = false;
            let started = Instant::now();
            let result = self.run_session(&address, &mut registered).await;
            if let Err(err) = &result {
                if is_fatal(err) {
                    return result;
                }
            }
            if self.is_stopping() {
                break;
            }

            let stable =
                registered && started.elapsed() >= Duration::from_millis(STABLE_SESSION_MS);
            failures = if stable { 0 } else { failures + 1 };
            let reason = match &result {
                Err(err) => error_chain(err.as_ref()),
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
                _ = stop_rx.wait_for(|stopping| *stopping) => break,
                _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => {}
            }
        }
        // Invokes from a session that dropped may still be running.
        self.wait_drained().await;
        Ok(())
    }

    /// Stops gracefully: new invokes are refused as retriable while in-flight
    /// ones finish (up to `shutdown_grace_ms`), then the worker unregisters and
    /// closes its session, and [`run`](Self::run) returns. Doesn't block; safe
    /// to call from any thread and more than once.
    pub fn stop(&self) {
        if self.stop_requested.swap(true, Ordering::SeqCst) {
            return;
        }
        *self.drain_deadline.lock().unwrap() =
            Some(Instant::now() + Duration::from_millis(self.options.shutdown_grace_ms));
        let count = *self.in_flight.borrow();
        if count > 0 {
            log::info!(
                "Draining {} in-flight invoke(s) before stopping (up to {}ms)",
                count,
                self.options.shutdown_grace_ms
            );
        }
        self.stopping.send_replace(true);
    }

    /// Waits until no invoke is in flight, or the drain deadline passes.
    async fn wait_drained(&self) {
        let deadline = self
            .drain_deadline
            .lock()
            .unwrap()
            .unwrap_or_else(Instant::now);
        let mut in_flight = self.in_flight.subscribe();
        let _ = tokio::time::timeout_at(deadline.into(), in_flight.wait_for(|n| *n == 0)).await;
    }

    /// A new endpoint for one session, so a reconnect after the gateway's max
    /// connection age can reach another replica, plus the `authorization`
    /// value. TLS material and the token are read now, so rotated files apply
    /// from the next session.
    fn endpoint(
        &self,
        address: &GatewayAddress,
    ) -> Result<(Endpoint, Option<MetadataValue<Ascii>>), BoxError> {
        let authorization = match &self.options.token_file {
            Some(path) => {
                let token = std::fs::read_to_string(path)?;
                Some(format!("Bearer {}", token.trim()).parse::<MetadataValue<Ascii>>()?)
            }
            None => None,
        };
        let endpoint = match address {
            GatewayAddress::Unix { path } => Endpoint::from_shared(format!("unix://{}", path))?,
            GatewayAddress::Tcp { url, tls } => {
                let mut endpoint = Endpoint::from_shared(url.clone())?;
                if self.options.keepalive_interval_ms > 0 {
                    endpoint = endpoint
                        .http2_keep_alive_interval(Duration::from_millis(
                            self.options.keepalive_interval_ms,
                        ))
                        .keep_alive_timeout(Duration::from_millis(
                            self.options.keepalive_timeout_ms,
                        ))
                        .keep_alive_while_idle(true);
                }
                if *tls {
                    let mut config = ClientTlsConfig::new();
                    config = match &self.options.ca_file {
                        Some(path) => {
                            config.ca_certificate(Certificate::from_pem(std::fs::read(path)?))
                        }
                        None => config.with_native_roots(),
                    };
                    if let (Some(cert), Some(key)) =
                        (&self.options.cert_file, &self.options.key_file)
                    {
                        config = config.identity(Identity::from_pem(
                            std::fs::read(cert)?,
                            std::fs::read(key)?,
                        ));
                    }
                    endpoint = endpoint.tls_config(config)?;
                }
                endpoint
            }
        };
        Ok((endpoint, authorization))
    }

    /// One connect → register → serve cycle. Sets `registered` once the
    /// gateway acks; `run` resets the backoff only if a registered session also
    /// lasted [`STABLE_SESSION_MS`]. The gRPC channel is dropped (closed)
    /// before this returns.
    async fn run_session(
        &self,
        address: &GatewayAddress,
        registered: &mut bool,
    ) -> Result<(), BoxError> {
        let (tx, rx) = mpsc::unbounded_channel::<SessionRequest>();
        tx.send(SessionRequest {
            payload: Some(session_request::Payload::Register(Register {
                worker_id: self.options.worker_id.clone(),
                language: "rust".to_string(),
                protocol_version: "1.0".to_string(),
                actors: self.registered.clone(),
            })),
        })?;
        let outbox = Arc::new(SessionOutbox {
            tx: Mutex::new(Some(tx)),
        });

        let setup = async {
            let (endpoint, authorization) = self.endpoint(address)?;
            let channel = endpoint.connect().await?;
            let mut client = SidecarGatewayServiceClient::new(channel);
            let mut request = tonic::Request::new(UnboundedReceiverStream::new(rx));
            if let Some(value) = authorization {
                request.metadata_mut().insert("authorization", value);
            }
            let mut inbound = client.session(request).await?.into_inner();
            let first = inbound
                .next()
                .await
                .ok_or("expected register_ack but got EOF")??;
            match first.payload {
                Some(session_response::Payload::RegisterAck(ack)) if ack.accepted => {}
                Some(session_response::Payload::RegisterAck(_)) => {
                    return Err(Box::new(RegistrationRejectedError) as BoxError)
                }
                other => return Err(format!("expected register_ack but got {:?}", other).into()),
            }
            Ok::<
                (
                    SidecarGatewayServiceClient<Channel>,
                    Streaming<SessionResponse>,
                ),
                BoxError,
            >((client, inbound))
        };
        // stop() before the session is up abandons it; nothing is in flight.
        let mut stop_rx = self.stopping.subscribe();
        let (_client, mut inbound) = tokio::select! {
            result = setup => match result {
                Ok(session) => session,
                Err(err) => {
                    outbox.close(None);
                    return Err(err);
                }
            },
            _ = stop_rx.wait_for(|stopping| *stopping) => {
                outbox.close(Some(self.unregister()));
                return Ok(());
            }
        };
        *registered = true;

        log::info!(
            "Worker {} registered {} actor(s) with the gateway",
            self.options.worker_id,
            self.registered.len()
        );

        let heartbeat_handle = {
            let outbox = outbox.clone();
            let worker_id = self.options.worker_id.clone();
            let heartbeat_ms = self.options.heartbeat_ms;
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(heartbeat_ms)).await;
                    let msg = SessionRequest {
                        payload: Some(session_request::Payload::Heartbeat(Heartbeat {
                            worker_id: worker_id.clone(),
                        })),
                    };
                    if !outbox.send(msg) {
                        break;
                    }
                }
            })
        };

        let serve_result = self.serve_loop(&mut inbound, &outbox).await;

        heartbeat_handle.abort();
        outbox.close(Some(self.unregister()));

        serve_result
    }

    fn unregister(&self) -> SessionRequest {
        SessionRequest {
            payload: Some(session_request::Payload::Unregister(Unregister {
                worker_id: self.options.worker_id.clone(),
            })),
        }
    }

    async fn serve_loop(
        &self,
        inbound: &mut Streaming<SessionResponse>,
        outbox: &Arc<SessionOutbox>,
    ) -> Result<(), BoxError> {
        let mut stop_rx = self.stopping.subscribe();
        let mut draining = false;
        // Set once drained and the request stream is closed.
        let mut closed_at: Option<tokio::time::Instant> = None;
        loop {
            tokio::select! {
                message = inbound.next() => {
                    let response = match message {
                        Some(Ok(r)) => r,
                        Some(Err(status)) => {
                            // After stop() the gateway may close the stream
                            // with a status rather than a clean EOF; that's a
                            // normal shutdown.
                            if self.is_stopping() {
                                break;
                            }
                            return Err(Box::new(status));
                        }
                        None => break,
                    };
                    let Some(session_response::Payload::Invoke(invoke)) = response.payload else {
                        continue;
                    };
                    if self.is_stopping() {
                        // Draining: refuse as retriable, so the gateway
                        // leaves the message on its queue for another worker
                        // (#396).
                        send_error(
                            outbox,
                            &invoke.invoke_id,
                            "WORKER_DRAINING",
                            "worker is shutting down",
                            true,
                        );
                    } else {
                        self.spawn_invoke(invoke, outbox.clone());
                    }
                }
                _ = stop_rx.wait_for(|stopping| *stopping), if !draining => draining = true,
                // Drained: unregister and end the request stream, then keep
                // reading until the gateway ends its side (it does once it
                // sees ours end). Returning now would drop the connection
                // before the unregister goes out.
                _ = self.wait_drained(), if draining && closed_at.is_none() => {
                    outbox.close(Some(self.unregister()));
                    closed_at = Some(tokio::time::Instant::now());
                }
                _ = async { tokio::time::sleep_until(closed_at.unwrap() + CLOSE_WAIT).await },
                    if closed_at.is_some() => break,
            }
        }
        Ok(())
    }

    /// Runs one invoke on its own task: not awaited, so invokes run
    /// concurrently, each actor bounded by its own slots.
    fn spawn_invoke(&self, body: Invoke, outbox: Arc<SessionOutbox>) {
        let key = actor_key(
            &body.parent_fsm_name,
            &body.parent_fsm_version,
            &body.async_operation_type,
            &body.async_operation_name,
            &body.async_operation_version,
            &body.async_operation_language,
        );
        let (handler, slots) = match (self.handlers.get(&key), self.slots.get(&key)) {
            (Some(handler), Some(slots)) => (handler.clone(), slots.clone()),
            _ => {
                log::warn!("Invoke {} for unknown actor {}", body.invoke_id, key);
                send_error(
                    &outbox,
                    &body.invoke_id,
                    "NOT_FOUND",
                    &format!("actor not found: {}", key),
                    false,
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
                    send_error(
                        &outbox,
                        &body.invoke_id,
                        "INTERNAL",
                        &format!("invalid input_json: {}", e),
                        false,
                    );
                    return;
                }
            }
        };

        let in_flight = InFlight::new(self.in_flight.clone());
        tokio::spawn(async move {
            let _in_flight = in_flight;
            // Never run more of this actor than declared, even if the gateway
            // sends more (after its own invoke timeout, or through a direct
            // Invoke() RPC).
            let Ok(_permit) = slots.acquire_owned().await else {
                return;
            };
            let started = Instant::now();
            // Handlers are sync and may block, so they run on the blocking
            // pool rather than a runtime worker thread.
            let outcome = tokio::task::spawn_blocking(move || {
                catch_unwind(AssertUnwindSafe(|| handler(input)))
            })
            .await;
            match outcome {
                Ok(Ok(output)) => {
                    let output_json =
                        serde_json::to_string(&output).unwrap_or_else(|_| "null".to_string());
                    let duration_ms = started.elapsed().as_millis().min(u32::MAX as u128) as u32;
                    push_result(
                        &outbox,
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
                Ok(Err(panic_payload)) => {
                    let message = panic_message(&panic_payload);
                    log::error!("Actor {} panicked: {}", key, message);
                    send_error(&outbox, &body.invoke_id, "INTERNAL", &message, false);
                }
                Err(join_error) => {
                    send_error(
                        &outbox,
                        &body.invoke_id,
                        "INTERNAL",
                        &join_error.to_string(),
                        false,
                    );
                }
            }
        });
    }
}

/// Pushes an invoke's result or error. If the invoke outlived its session the
/// result can't go out on a later one (the gateway matches results to the
/// connection it sent the invoke on, and has already failed it as
/// WORKER_DISCONNECTED), so log instead of dropping it silently.
fn push_result(outbox: &SessionOutbox, msg: SessionRequest, invoke_id: &str) {
    if !outbox.send(msg) {
        log::warn!(
            "Dropping result of invoke {}: its gateway session ended",
            invoke_id
        );
    }
}

fn send_error(outbox: &SessionOutbox, invoke_id: &str, code: &str, message: &str, retriable: bool) {
    push_result(
        outbox,
        SessionRequest {
            payload: Some(session_request::Payload::InvokeError(InvokeError {
                invoke_id: invoke_id.to_string(),
                error: Some(InvokeErrorDetail {
                    code: code.to_string(),
                    message: message.to_string(),
                    retriable,
                }),
                duration_ms: 0,
            })),
        },
        invoke_id,
    );
}

/// `err` followed by each of its `source()`s, joined with `: `. tonic's
/// top-level connection error is just "transport error"; the useful part (for
/// example "No such file or directory", or a TLS failure) is further down.
pub(crate) fn error_chain(err: &(dyn std::error::Error + 'static)) -> String {
    let mut message = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !message.ends_with(&text) {
            message.push_str(": ");
            message.push_str(&text);
        }
        source = cause.source();
    }
    message
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
