//! SPEC-007 worker side, over real TCP sockets: TLS + bearer token (and token
//! rotation), mutual TLS, an untrusted server, plaintext test mode,
//! concurrency (worker-wide and per actor, with precedence), graceful drain,
//! and reconnecting after the server's max connection age.
//!
//! The gateway here is a tonic server built from the same stubs (TLS/mTLS via
//! `ServerTlsConfig`, max age via `Server::max_connection_age`), so the tests
//! need no Deno gateway. It checks the bearer token the way the real one does:
//! missing or wrong → UNAUTHENTICATED before the Register is read. TLS
//! fixtures are made by `openssl` at test time, so no key is committed. Same
//! coverage as the Python SDK's test_transport_concurrency.py.

use pgfsm_async_worker_sdk::{
    effective_max_concurrency, parse_gateway_address, ActorRegistration, ActorWorker,
    ActorWorkerOptions, GatewayAddress,
};
use pgfsm_proto_codegen::pgfsm::sidecargateway::v1::sidecar_gateway_service_server::{
    SidecarGatewayService, SidecarGatewayServiceServer,
};
use pgfsm_proto_codegen::pgfsm::sidecargateway::v1::{
    session_request, session_response, Invoke, InvokeError, InvokeResult, Register, RegisterAck,
    SessionRequest, SessionResponse,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_stream::wrappers::{TcpListenerStream, UnboundedReceiverStream};
use tokio_stream::StreamExt;
use tonic::transport::{Certificate, Identity, ServerTlsConfig};
use tonic::{Request, Response, Status, Streaming};

const TIMEOUT: Duration = Duration::from_secs(5);

// --- TLS fixtures -----------------------------------------------------------

/// A CA, a server certificate for localhost/127.0.0.1 and a client
/// certificate (mutual TLS), all signed by that CA, in a temp dir.
struct Tls {
    dir: tempfile::TempDir,
}

impl Tls {
    #[rustfmt::skip]
    fn new() -> Self {
        let dir = tempfile::Builder::new()
            .prefix("pgfsm-tls-")
            .tempdir()
            .unwrap();
        let d = dir.path();
        openssl(d, &["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=pgfsm-test-ca"]);
        openssl(d, &["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key",
            "-out", "server.csr", "-subj", "/CN=localhost"]);
        std::fs::write(d.join("san.ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n").unwrap();
        openssl(d, &["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
            "-CAcreateserial", "-days", "1", "-out", "server.crt", "-extfile", "san.ext"]);
        openssl(d, &["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "client.key",
            "-out", "client.csr", "-subj", "/CN=pgfsm-test-worker"]);
        openssl(d, &["x509", "-req", "-in", "client.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
            "-CAcreateserial", "-days", "1", "-out", "client.crt"]);
        Tls { dir }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn read(&self, name: &str) -> Vec<u8> {
        std::fs::read(self.path(name)).unwrap()
    }
}

fn openssl(dir: &Path, args: &[&str]) {
    let out = Command::new("openssl")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("openssl must be on PATH");
    assert!(
        out.status.success(),
        "openssl {} failed: {}",
        args[0],
        String::from_utf8_lossy(&out.stderr)
    );
}

// --- Fake gateway -------------------------------------------------------------

type Outbound = mpsc::UnboundedSender<Result<SessionResponse, Status>>;

/// Plays the gateway's side of each Session: checks the token, acks the
/// Register, then relays what `invoke()` queues to the latest session and
/// records everything the worker sends on `from_worker`.
#[derive(Clone)]
struct Gateway {
    token: Option<String>,
    registers: Arc<Mutex<Vec<Register>>>,
    authorizations: Arc<Mutex<Vec<Option<String>>>>,
    current: Arc<Mutex<Option<(u64, Outbound)>>>,
    next_session: Arc<AtomicU64>,
    from_worker: mpsc::UnboundedSender<SessionRequest>,
}

#[tonic::codegen::async_trait]
impl SidecarGatewayService for Gateway {
    type SessionStream = UnboundedReceiverStream<Result<SessionResponse, Status>>;

    async fn session(
        &self,
        request: Request<Streaming<SessionRequest>>,
    ) -> Result<Response<Self::SessionStream>, Status> {
        let authorization = request
            .metadata()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        self.authorizations
            .lock()
            .unwrap()
            .push(authorization.clone());
        if let Some(token) = &self.token {
            if authorization.as_deref() != Some(format!("Bearer {}", token).as_str()) {
                return Err(Status::unauthenticated("missing or invalid bearer token"));
            }
        }
        let mut inbound = request.into_inner();
        let (tx, rx) = mpsc::unbounded_channel();
        let id = self.next_session.fetch_add(1, Ordering::SeqCst);
        let gateway = self.clone();
        tokio::spawn(async move {
            let Some(Ok(first)) = inbound.next().await else {
                return;
            };
            let Some(session_request::Payload::Register(register)) = first.payload else {
                return;
            };
            *gateway.current.lock().unwrap() = Some((id, tx.clone()));
            gateway.registers.lock().unwrap().push(register);
            let _ = tx.send(Ok(SessionResponse {
                payload: Some(session_response::Payload::RegisterAck(RegisterAck {
                    accepted: true,
                    ..Default::default()
                })),
            }));
            drop(tx);
            while let Some(Ok(msg)) = inbound.next().await {
                let _ = gateway.from_worker.send(msg);
            }
            // The worker ended its stream: end ours too.
            let mut current = gateway.current.lock().unwrap();
            if current.as_ref().is_some_and(|(cid, _)| *cid == id) {
                *current = None;
            }
        });
        Ok(Response::new(UnboundedReceiverStream::new(rx)))
    }
}

struct Harness {
    gateway: Gateway,
    from_worker: mpsc::UnboundedReceiver<SessionRequest>,
    url: String,
    server: JoinHandle<()>,
}

#[derive(Default)]
struct ServeOptions<'a> {
    tls: Option<&'a Tls>,
    mtls: bool,
    token: Option<&'a str>,
    max_connection_age: Option<Duration>,
}

impl Harness {
    async fn start(options: ServeOptions<'_>) -> Self {
        let (from_tx, from_rx) = mpsc::unbounded_channel();
        let gateway = Gateway {
            token: options.token.map(String::from),
            registers: Default::default(),
            authorizations: Default::default(),
            current: Default::default(),
            next_session: Default::default(),
            from_worker: from_tx,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut builder = tonic::transport::Server::builder();
        if let Some(age) = options.max_connection_age {
            builder = builder
                .max_connection_age(age)
                .max_connection_age_grace(Duration::from_millis(200));
        }
        let url = match options.tls {
            Some(tls) => {
                let mut config = ServerTlsConfig::new().identity(Identity::from_pem(
                    tls.read("server.crt"),
                    tls.read("server.key"),
                ));
                if options.mtls {
                    config = config.client_ca_root(Certificate::from_pem(tls.read("ca.crt")));
                }
                builder = builder.tls_config(config).unwrap();
                format!("https://127.0.0.1:{}", port)
            }
            None => format!("http://127.0.0.1:{}", port),
        };
        let service = SidecarGatewayServiceServer::new(gateway.clone());
        let server = tokio::spawn(async move {
            let _ = builder
                .add_service(service)
                .serve_with_incoming(TcpListenerStream::new(listener))
                .await;
        });
        Harness {
            gateway,
            from_worker: from_rx,
            url,
            server,
        }
    }

    fn registers(&self) -> Vec<Register> {
        self.gateway.registers.lock().unwrap().clone()
    }

    fn authorizations(&self) -> Vec<Option<String>> {
        self.gateway.authorizations.lock().unwrap().clone()
    }

    fn invoke(&self, invoke_id: &str, name: &str, n: i64) {
        let current = self.gateway.current.lock().unwrap();
        let (_, tx) = current.as_ref().expect("no live session");
        tx.send(Ok(SessionResponse {
            payload: Some(session_response::Payload::Invoke(Invoke {
                invoke_id: invoke_id.to_string(),
                parent_fsm_name: "creditCheck".into(),
                parent_fsm_version: "v01".into(),
                async_operation_type: "internalAsyncOperation".into(),
                async_operation_name: name.into(),
                async_operation_version: "v01".into(),
                async_operation_language: "rust".into(),
                input_json: json!({ "n": n }).to_string(),
                ..Default::default()
            })),
        }))
        .unwrap();
    }

    async fn next_of(
        &mut self,
        want: fn(&session_request::Payload) -> bool,
    ) -> session_request::Payload {
        tokio::time::timeout(TIMEOUT, async {
            loop {
                let msg = self.from_worker.recv().await.expect("gateway gone");
                if let Some(p) = msg.payload {
                    if want(&p) {
                        return p;
                    }
                }
            }
        })
        .await
        .expect("timed out waiting for a message from the worker")
    }

    async fn result(&mut self) -> InvokeResult {
        match self
            .next_of(|p| matches!(p, session_request::Payload::InvokeResult(_)))
            .await
        {
            session_request::Payload::InvokeResult(r) => r,
            _ => unreachable!(),
        }
    }

    async fn error(&mut self) -> InvokeError {
        match self
            .next_of(|p| matches!(p, session_request::Payload::InvokeError(_)))
            .await
        {
            session_request::Payload::InvokeError(e) => e,
            _ => unreachable!(),
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn wait_for(condition: impl Fn() -> bool) {
    let deadline = Instant::now() + TIMEOUT;
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

// --- Workers ------------------------------------------------------------------

fn actor(
    name: &str,
    handler: impl Fn(Value) -> Value + Send + Sync + 'static,
) -> ActorRegistration {
    ActorRegistration::new(
        "creditCheck",
        "v01",
        "internalAsyncOperation",
        name,
        "v01",
        "rust",
        handler,
    )
}

fn double() -> ActorRegistration {
    actor(
        "double",
        |input| json!({ "doubled": input["n"].as_i64().unwrap() * 2 }),
    )
}

fn options(url: &str) -> ActorWorkerOptions {
    ActorWorkerOptions {
        worker_id: "w-test".into(),
        gateway_address: Some(url.to_string()),
        heartbeat_ms: 50,
        reconnect_initial_delay_ms: 20,
        reconnect_max_delay_ms: 100,
        ..Default::default()
    }
}

/// A worker running on its own task until `stop_and_join`.
struct Running {
    worker: Arc<ActorWorker>,
    run: JoinHandle<Result<(), String>>,
}

impl Running {
    fn start(options: ActorWorkerOptions, registrations: Vec<ActorRegistration>) -> Self {
        let worker = Arc::new(ActorWorker::new(options, registrations));
        let run = tokio::spawn({
            let worker = worker.clone();
            async move { worker.run().await.map_err(|e| e.to_string()) }
        });
        Running { worker, run }
    }

    async fn stop_and_join(self) {
        self.worker.stop();
        let result = tokio::time::timeout(Duration::from_secs(10), self.run)
            .await
            .expect("run() didn't return after stop()");
        assert_eq!(result.unwrap(), Ok(()));
    }
}

async fn run_to_error(options: ActorWorkerOptions) -> String {
    let worker = ActorWorker::new(options, vec![double()]);
    tokio::time::timeout(Duration::from_secs(10), worker.run())
        .await
        .expect("run() didn't return")
        .expect_err("run() should fail")
        .to_string()
}

/// A handler that blocks until released, recording how many run at once.
#[derive(Default)]
struct Gate {
    state: Mutex<GateState>,
    changed: Condvar,
}

#[derive(Default)]
struct GateState {
    running: usize,
    peak: usize,
    started: usize,
    permits: usize,
}

impl Gate {
    fn handler(self: &Arc<Self>) -> impl Fn(Value) -> Value + Send + Sync + 'static {
        let gate = self.clone();
        move |input| {
            let mut state = gate.state.lock().unwrap();
            state.started += 1;
            state.running += 1;
            state.peak = state.peak.max(state.running);
            let (mut state, _) = gate
                .changed
                .wait_timeout_while(state, Duration::from_secs(10), |s| s.permits == 0)
                .unwrap();
            state.permits = state.permits.saturating_sub(1);
            state.running -= 1;
            json!({ "done": input["n"] })
        }
    }

    fn snapshot(&self) -> (usize, usize, usize) {
        let s = self.state.lock().unwrap();
        (s.running, s.started, s.peak)
    }

    fn release(&self, n: usize) {
        self.state.lock().unwrap().permits += n;
        self.changed.notify_all();
    }
}

// --- Tests ----------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn tls_and_bearer_token_register_and_serve() {
    let tls = Tls::new();
    std::fs::write(tls.path("token"), "s3cret\n").unwrap();
    let mut h = Harness::start(ServeOptions {
        tls: Some(&tls),
        token: Some("s3cret"),
        ..Default::default()
    })
    .await;
    let worker = Running::start(
        ActorWorkerOptions {
            ca_file: Some(tls.path("ca.crt")),
            token_file: Some(tls.path("token")),
            ..options(&h.url)
        },
        vec![double()],
    );
    wait_for(|| h.registers().len() == 1).await;
    h.invoke("inv-1", "double", 21);
    let result = h.result().await;
    assert_eq!(
        serde_json::from_str::<Value>(&result.output_json).unwrap(),
        json!({ "doubled": 42 })
    );
    worker.stop_and_join().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_token_fails_fast_with_unauthenticated() {
    let tls = Tls::new();
    std::fs::write(tls.path("bad-token"), "nope").unwrap();
    let h = Harness::start(ServeOptions {
        tls: Some(&tls),
        token: Some("s3cret"),
        ..Default::default()
    })
    .await;
    let err = run_to_error(ActorWorkerOptions {
        ca_file: Some(tls.path("ca.crt")),
        token_file: Some(tls.path("bad-token")),
        ..options(&h.url)
    })
    .await;
    assert!(err.contains("bearer token"), "{}", err);
    assert_eq!(h.authorizations().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_token_file_is_re_read_on_every_reconnect() {
    let tls = Tls::new();
    std::fs::write(tls.path("token"), "first").unwrap();
    let h = Harness::start(ServeOptions {
        tls: Some(&tls),
        max_connection_age: Some(Duration::from_millis(300)),
        ..Default::default()
    })
    .await;
    let worker = Running::start(
        ActorWorkerOptions {
            ca_file: Some(tls.path("ca.crt")),
            token_file: Some(tls.path("token")),
            ..options(&h.url)
        },
        vec![double()],
    );
    wait_for(|| h.registers().len() == 1).await;
    std::fs::write(tls.path("token"), "second").unwrap();
    wait_for(|| h.registers().len() >= 2).await;
    worker.stop_and_join().await;
    let seen = h.authorizations();
    assert_eq!(seen.first().unwrap().as_deref(), Some("Bearer first"));
    assert_eq!(seen.last().unwrap().as_deref(), Some("Bearer second"));
}

#[tokio::test(flavor = "multi_thread")]
async fn mutual_tls_with_and_without_a_client_certificate() {
    let tls = Tls::new();
    let mut h = Harness::start(ServeOptions {
        tls: Some(&tls),
        mtls: true,
        ..Default::default()
    })
    .await;
    let worker = Running::start(
        ActorWorkerOptions {
            ca_file: Some(tls.path("ca.crt")),
            cert_file: Some(tls.path("client.crt")),
            key_file: Some(tls.path("client.key")),
            ..options(&h.url)
        },
        vec![double()],
    );
    wait_for(|| h.registers().len() == 1).await;
    h.invoke("inv-1", "double", 2);
    assert_eq!(
        serde_json::from_str::<Value>(&h.result().await.output_json).unwrap(),
        json!({ "doubled": 4 })
    );
    worker.stop_and_join().await;

    let err = run_to_error(ActorWorkerOptions {
        ca_file: Some(tls.path("ca.crt")),
        reconnect_max_attempts: 2,
        reconnect_initial_delay_ms: 10,
        reconnect_max_delay_ms: 20,
        ..options(&h.url)
    })
    .await;
    assert!(err.contains("giving up"), "{}", err);
    assert_eq!(h.registers().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_untrusted_server_certificate_is_refused() {
    // No ca_file: the test CA isn't in the system roots.
    let tls = Tls::new();
    let h = Harness::start(ServeOptions {
        tls: Some(&tls),
        ..Default::default()
    })
    .await;
    let err = run_to_error(ActorWorkerOptions {
        reconnect_max_attempts: 2,
        reconnect_initial_delay_ms: 10,
        reconnect_max_delay_ms: 20,
        ..options(&h.url)
    })
    .await;
    assert!(err.contains("giving up"), "{}", err);
    assert!(h.registers().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn plaintext_http_address() {
    let mut h = Harness::start(ServeOptions::default()).await;
    let worker = Running::start(options(&h.url), vec![double()]);
    wait_for(|| h.registers().len() == 1).await;
    h.invoke("inv-1", "double", 5);
    assert_eq!(
        serde_json::from_str::<Value>(&h.result().await.output_json).unwrap(),
        json!({ "doubled": 10 })
    );
    worker.stop_and_join().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn invokes_run_concurrently_up_to_max_concurrency_and_never_beyond() {
    let mut h = Harness::start(ServeOptions::default()).await;
    let gate = Arc::new(Gate::default());
    let worker = Running::start(
        ActorWorkerOptions {
            max_concurrency: 2,
            ..options(&h.url)
        },
        vec![actor("slow", gate.handler())],
    );
    wait_for(|| h.registers().len() == 1).await;
    assert_eq!(h.registers()[0].actors[0].max_concurrency, 2);

    // Three invokes: two run at once, the third waits for a slot.
    for n in 1..=3 {
        h.invoke(&format!("inv-{}", n), "slow", n);
    }
    wait_for(|| gate.snapshot().0 == 2).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(gate.snapshot(), (2, 2, 2));

    // Finishing one frees its slot: only then does the third start.
    gate.release(1);
    wait_for(|| gate.snapshot().1 == 3).await;
    gate.release(2);
    let mut ids = Vec::new();
    for _ in 0..3 {
        ids.push(h.result().await.invoke_id);
    }
    ids.sort();
    assert_eq!(ids, ["inv-1", "inv-2", "inv-3"]);
    assert_eq!(gate.snapshot().2, 2);
    worker.stop_and_join().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_actors_own_max_concurrency_overrides_the_workers() {
    let mut h = Harness::start(ServeOptions::default()).await;
    let gate = Arc::new(Gate::default());
    let worker = Running::start(
        ActorWorkerOptions {
            max_concurrency: 5,
            ..options(&h.url)
        },
        vec![
            actor("capped", gate.handler()).with_max_concurrency(1),
            double(),
        ],
    );
    wait_for(|| h.registers().len() == 1).await;
    let declared: Vec<(String, u32)> = h.registers()[0]
        .actors
        .iter()
        .map(|a| (a.async_operation_name.clone(), a.max_concurrency))
        .collect();
    assert_eq!(
        declared,
        [("capped".to_string(), 1), ("double".to_string(), 5)]
    );

    // The capped actor runs one at a time even with free worker slots.
    h.invoke("inv-1", "capped", 1);
    h.invoke("inv-2", "capped", 2);
    wait_for(|| gate.snapshot().0 == 1).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(gate.snapshot(), (1, 1, 1));
    gate.release(1);
    wait_for(|| gate.snapshot().1 == 2).await;
    gate.release(1);
    h.result().await;
    h.result().await;
    assert_eq!(gate.snapshot().2, 1);
    worker.stop_and_join().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_drains_refusing_new_invokes_as_retriable() {
    let mut h = Harness::start(ServeOptions::default()).await;
    let gate = Arc::new(Gate::default());
    let worker = Running::start(
        ActorWorkerOptions {
            max_concurrency: 2,
            shutdown_grace_ms: 5000,
            ..options(&h.url)
        },
        vec![actor("slow", gate.handler())],
    );
    wait_for(|| h.registers().len() == 1).await;
    h.invoke("inv-1", "slow", 1);
    wait_for(|| gate.snapshot().0 == 1).await;

    worker.worker.stop(); // doesn't block; run() returns after the drain
                          // Arrives while draining: refused as retriable, not run.
    h.invoke("inv-2", "slow", 2);
    let err = h.error().await;
    let detail = err.error.unwrap();
    assert_eq!(
        (
            err.invoke_id.as_str(),
            detail.code.as_str(),
            detail.retriable
        ),
        ("inv-2", "WORKER_DRAINING", true)
    );
    assert_eq!(gate.snapshot().1, 1);
    assert!(!worker.run.is_finished());

    // The in-flight invoke still completes and its result goes out, then the
    // worker unregisters and run() returns.
    gate.release(1);
    assert_eq!(h.result().await.invoke_id, "inv-1");
    h.next_of(|p| matches!(p, session_request::Payload::Unregister(_)))
        .await;
    worker.stop_and_join().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_drain_gives_up_after_shutdown_grace_ms() {
    let h = Harness::start(ServeOptions::default()).await;
    let gate = Arc::new(Gate::default());
    let worker = Running::start(
        ActorWorkerOptions {
            shutdown_grace_ms: 200,
            ..options(&h.url)
        },
        vec![actor("slow", gate.handler())],
    );
    wait_for(|| h.registers().len() == 1).await;
    h.invoke("inv-1", "slow", 1);
    wait_for(|| gate.snapshot().0 == 1).await;
    let started = Instant::now();
    worker.stop_and_join().await;
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    gate.release(1);
}

#[tokio::test(flavor = "multi_thread")]
async fn reconnects_after_the_servers_max_connection_age() {
    let mut h = Harness::start(ServeOptions {
        max_connection_age: Some(Duration::from_millis(300)),
        ..Default::default()
    })
    .await;
    let worker = Running::start(options(&h.url), vec![double()]);
    wait_for(|| h.registers().len() >= 2).await;
    h.invoke("inv-1", "double", 4);
    assert_eq!(
        serde_json::from_str::<Value>(&h.result().await.output_json).unwrap(),
        json!({ "doubled": 8 })
    );
    worker.stop_and_join().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_invalid_gateway_address_is_an_error() {
    let err = run_to_error(options("tcp://gw:1")).await;
    assert!(err.contains("gateway address"), "{}", err);
}

#[test]
fn parses_gateway_addresses() {
    assert_eq!(
        parse_gateway_address("unix:/tmp/x.sock"),
        Ok(GatewayAddress::Unix {
            path: "/tmp/x.sock".into()
        })
    );
    assert_eq!(
        parse_gateway_address("https://gw:7443"),
        Ok(GatewayAddress::Tcp {
            url: "https://gw:7443".into(),
            tls: true
        })
    );
    assert_eq!(
        parse_gateway_address("http://127.0.0.1:7443/"),
        Ok(GatewayAddress::Tcp {
            url: "http://127.0.0.1:7443".into(),
            tls: false
        })
    );
    for bad in [
        "unix:",
        "tcp://gw:1",
        "https://gw",
        "gw:7443",
        "https://gw:x",
    ] {
        assert!(parse_gateway_address(bad).is_err(), "{}", bad);
    }
}

#[test]
fn effective_max_concurrency_is_actor_then_worker_then_1() {
    assert_eq!(effective_max_concurrency(3, 10), 3);
    assert_eq!(effective_max_concurrency(0, 10), 10);
    assert_eq!(effective_max_concurrency(0, 0), 1);
}
