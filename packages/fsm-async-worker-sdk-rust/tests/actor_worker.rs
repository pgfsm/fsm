//! `ActorWorker` and the CLI's `start` path end to end against an in-process
//! `SidecarGatewayService` over a real Unix socket: register, invoke, a
//! panicking handler surfacing as INTERNAL, an unknown actor as NOT_FOUND,
//! unregister on stop, and a rejected registration.
//!
//! The fake gateway is a tonic server built from the same pgfsm-proto-codegen
//! stubs; it plays the gateway's side of the Session stream just far enough to
//! drive the worker. Same coverage as the Python SDK's test_actor_worker.py.

use pgfsm_async_worker_sdk::{
    reconnect_delay_ms, run_actor_worker_cli, ActorRegistration, ActorWorker, ActorWorkerOptions,
    RegistrationRejectedError,
};
use pgfsm_proto_codegen::pgfsm::sidecargateway::v1::sidecar_gateway_service_server::{
    SidecarGatewayService, SidecarGatewayServiceServer,
};
use pgfsm_proto_codegen::pgfsm::sidecargateway::v1::{
    session_request, session_response, Invoke, RegisterAck, SessionRequest, SessionResponse,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::UnixListener;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_stream::wrappers::{UnboundedReceiverStream, UnixListenerStream};
use tokio_stream::StreamExt;
use tonic::{Request, Response, Status, Streaming};

const TIMEOUT: Duration = Duration::from_secs(5);

/// Acks the registration (accepted or not), then relays whatever the test
/// queues on `to_worker`, and records every message the worker sends on
/// `from_worker`. With `close_after_ack`, it ends the stream right after the
/// ack instead.
struct FakeGateway {
    accept: bool,
    close_after_ack: bool,
    /// When set, fails every session with this status code.
    abort_with: Option<tonic::Code>,
    sessions: Arc<std::sync::atomic::AtomicUsize>,
    to_worker: Mutex<Option<mpsc::UnboundedReceiver<SessionResponse>>>,
    from_worker: mpsc::UnboundedSender<SessionRequest>,
    /// Flipped to `true` to simulate a crash: every live session fails with
    /// UNAVAILABLE.
    crashed: watch::Receiver<bool>,
}

#[tonic::codegen::async_trait]
impl SidecarGatewayService for FakeGateway {
    type SessionStream = UnboundedReceiverStream<Result<SessionResponse, Status>>;

    async fn session(
        &self,
        request: Request<Streaming<SessionRequest>>,
    ) -> Result<Response<Self::SessionStream>, Status> {
        self.sessions
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if let Some(code) = self.abort_with {
            return Err(Status::new(code, "refused by test gateway"));
        }
        let mut inbound = request.into_inner();
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let mut to_worker = self.to_worker.lock().unwrap().take();
        let from_worker = self.from_worker.clone();
        let accept = self.accept;
        let close_after_ack = self.close_after_ack;
        let mut crashed = self.crashed.clone();

        tokio::spawn(async move {
            let mut out_tx = Some(out_tx);
            loop {
                tokio::select! {
                    _ = crashed.wait_for(|c| *c) => {
                        if let Some(tx) = out_tx.take() {
                            let _ = tx.send(Err(Status::unavailable("gateway crashed")));
                        }
                        break;
                    }
                    msg = inbound.next() => {
                        let Some(Ok(msg)) = msg else { break };
                        let is_register = matches!(msg.payload, Some(session_request::Payload::Register(_)));
                        let _ = from_worker.send(msg);
                        if is_register {
                            if let Some(tx) = &out_tx {
                                let _ = tx.send(Ok(SessionResponse {
                                    payload: Some(session_response::Payload::RegisterAck(RegisterAck {
                                        accepted: accept,
                                        ..Default::default()
                                    })),
                                }));
                            }
                            if !accept || close_after_ack {
                                out_tx = None; // ends the response stream
                            }
                        }
                    }
                    item = async {
                        match to_worker.as_mut() {
                            Some(rx) => rx.recv().await,
                            None => std::future::pending().await,
                        }
                    } => {
                        match (item, &out_tx) {
                            (Some(resp), Some(tx)) => { let _ = tx.send(Ok(resp)); }
                            (None, _) => to_worker = None,
                            _ => {}
                        }
                    }
                }
            }
        });

        Ok(Response::new(UnboundedReceiverStream::new(out_rx)))
    }
}

struct Harness {
    socket_path: PathBuf,
    to_worker: mpsc::UnboundedSender<SessionResponse>,
    from_worker: mpsc::UnboundedReceiver<SessionRequest>,
    crash: watch::Sender<bool>,
    server: JoinHandle<()>,
    sessions: Arc<std::sync::atomic::AtomicUsize>,
    _dir: Arc<tempfile::TempDir>,
}

impl Harness {
    async fn start(accept: bool, close_after_ack: bool) -> Self {
        Self::serve(temp_dir(), accept, close_after_ack)
    }

    fn start_aborting(code: tonic::Code) -> Self {
        Self::serve_with(temp_dir(), true, false, Some(code))
    }

    fn sessions(&self) -> usize {
        self.sessions.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Simulates a gateway crash: stops accepting connections, then fails
    /// every live session. Returns the directory so a new gateway can be
    /// served on the same socket path.
    fn crash(self) -> Arc<tempfile::TempDir> {
        self.server.abort();
        let _ = self.crash.send(true);
        self._dir
    }

    fn serve(dir: Arc<tempfile::TempDir>, accept: bool, close_after_ack: bool) -> Self {
        Self::serve_with(dir, accept, close_after_ack, None)
    }

    fn serve_with(
        dir: Arc<tempfile::TempDir>,
        accept: bool,
        close_after_ack: bool,
        abort_with: Option<tonic::Code>,
    ) -> Self {
        let sessions = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let socket_path = dir.path().join("gw.sock");
        let _ = std::fs::remove_file(&socket_path);
        let (crash_tx, crash_rx) = watch::channel(false);
        let (to_worker_tx, to_worker_rx) = mpsc::unbounded_channel();
        let (from_worker_tx, from_worker_rx) = mpsc::unbounded_channel();
        let gateway = FakeGateway {
            accept,
            close_after_ack,
            to_worker: Mutex::new(Some(to_worker_rx)),
            from_worker: from_worker_tx,
            crashed: crash_rx,
            abort_with,
            sessions: sessions.clone(),
        };
        let listener = UnixListener::bind(&socket_path).unwrap();
        let server = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(SidecarGatewayServiceServer::new(gateway))
                .serve_with_incoming(UnixListenerStream::new(listener))
                .await
                .unwrap();
        });
        Harness {
            socket_path,
            to_worker: to_worker_tx,
            from_worker: from_worker_rx,
            crash: crash_tx,
            server,
            sessions,
            _dir: dir,
        }
    }

    /// The next message from the worker with the given payload kind, skipping
    /// others (e.g. heartbeats).
    async fn next_of(
        &mut self,
        want: fn(&session_request::Payload) -> bool,
    ) -> session_request::Payload {
        tokio::time::timeout(TIMEOUT, async {
            loop {
                let msg = self.from_worker.recv().await.expect("worker stream ended");
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

    fn invoke(&self, invoke_id: &str, name: &str, input: Value) {
        self.to_worker
            .send(SessionResponse {
                payload: Some(session_response::Payload::Invoke(Invoke {
                    invoke_id: invoke_id.to_string(),
                    parent_fsm_name: "creditCheck".into(),
                    parent_fsm_version: "v01".into(),
                    async_operation_type: "internalAsyncOperation".into(),
                    async_operation_name: name.into(),
                    async_operation_version: "v01".into(),
                    async_operation_language: "rust".into(),
                    input_json: input.to_string(),
                    ..Default::default()
                })),
            })
            .unwrap();
    }
}

fn temp_dir() -> Arc<tempfile::TempDir> {
    // AF_UNIX paths are capped at ~104 bytes on macOS, so keep it short.
    Arc::new(
        tempfile::Builder::new()
            .prefix("pgfsm-")
            .tempdir_in("/tmp")
            .unwrap(),
    )
}

fn check_bureau(input: Value) -> Value {
    json!({ "input": input, "msg": "checkBureau actor invoked by rust" })
}

fn failing(_input: Value) -> Value {
    panic!("boom")
}

fn registrations() -> Vec<ActorRegistration> {
    vec![
        ActorRegistration::new(
            "creditCheck",
            "v01",
            "internalAsyncOperation",
            "checkBureau",
            "v01",
            "rust",
            check_bureau,
        ),
        ActorRegistration::new(
            "creditCheck",
            "v01",
            "internalAsyncOperation",
            "failing",
            "v01",
            "rust",
            failing,
        ),
    ]
}

fn worker(socket_path: &Path) -> Arc<ActorWorker> {
    Arc::new(ActorWorker::new(
        ActorWorkerOptions {
            worker_id: "w-test".into(),
            gateway_socket_path: socket_path.to_string_lossy().into_owned(),
            heartbeat_ms: 50,
            reconnect_initial_delay_ms: 10,
            reconnect_max_delay_ms: 50,
            ..Default::default()
        },
        registrations(),
    ))
}

#[tokio::test(flavor = "multi_thread")]
async fn registers_serves_invokes_and_unregisters_on_stop() {
    let mut h = Harness::start(true, false).await;
    let worker = worker(&h.socket_path);
    let run = tokio::spawn({
        let worker = worker.clone();
        async move { worker.run().await.map_err(|e| e.to_string()) }
    });

    let session_request::Payload::Register(register) = h
        .next_of(|p| matches!(p, session_request::Payload::Register(_)))
        .await
    else {
        unreachable!()
    };
    assert_eq!(register.worker_id, "w-test");
    assert_eq!(register.language, "rust");
    assert_eq!(register.actors.len(), 2);

    // A heartbeat arrives on its own at the 50ms interval.
    h.next_of(|p| matches!(p, session_request::Payload::Heartbeat(_)))
        .await;

    h.invoke("i-1", "checkBureau", json!({ "applicant": "a1" }));
    let session_request::Payload::InvokeResult(result) = h
        .next_of(|p| matches!(p, session_request::Payload::InvokeResult(_)))
        .await
    else {
        unreachable!()
    };
    assert_eq!(result.invoke_id, "i-1");
    let output: Value = serde_json::from_str(&result.output_json).unwrap();
    assert_eq!(output["input"], json!({ "applicant": "a1" }));

    h.invoke("i-2", "failing", json!(null));
    let session_request::Payload::InvokeError(err) = h
        .next_of(|p| matches!(p, session_request::Payload::InvokeError(_)))
        .await
    else {
        unreachable!()
    };
    assert_eq!(err.invoke_id, "i-2");
    let detail = err.error.unwrap();
    assert_eq!(detail.code, "INTERNAL");
    assert_eq!(detail.message, "boom");

    h.invoke("i-3", "noSuchActor", json!(null));
    let session_request::Payload::InvokeError(err) = h
        .next_of(|p| matches!(p, session_request::Payload::InvokeError(_)))
        .await
    else {
        unreachable!()
    };
    assert_eq!(err.invoke_id, "i-3");
    assert_eq!(err.error.unwrap().code, "NOT_FOUND");

    worker.stop();
    let session_request::Payload::Unregister(unregister) = h
        .next_of(|p| matches!(p, session_request::Payload::Unregister(_)))
        .await
    else {
        unreachable!()
    };
    assert_eq!(unregister.worker_id, "w-test");

    let result = tokio::time::timeout(TIMEOUT, run)
        .await
        .expect("run() didn't return after stop()");
    assert_eq!(result.unwrap(), Ok(()));
}

#[tokio::test(flavor = "multi_thread")]
async fn rejected_registration_is_an_error() {
    let h = Harness::start(false, false).await;
    let worker = worker(&h.socket_path);
    let err = tokio::time::timeout(TIMEOUT, worker.run())
        .await
        .expect("run() didn't return")
        .unwrap_err();
    assert!(err.is::<RegistrationRejectedError>(), "{}", err);
}

#[tokio::test(flavor = "multi_thread")]
async fn empty_registry_refuses_to_run() {
    let worker = ActorWorker::new(
        ActorWorkerOptions {
            worker_id: "w-empty".into(),
            gateway_socket_path: "/nonexistent/gw.sock".into(),
            heartbeat_ms: 50,
            ..Default::default()
        },
        vec![],
    );
    assert!(worker.run().await.is_err());
}

fn is_register(p: &session_request::Payload) -> bool {
    matches!(p, session_request::Payload::Register(_))
}

fn is_invoke_result(p: &session_request::Payload) -> bool {
    matches!(p, session_request::Payload::InvokeResult(_))
}

// The CLI builds its own runtime, so it runs on a blocking thread here while
// the fake gateway lives on the test's runtime. The gateway ending the stream
// isn't the end of the worker: it reconnects and registers again. With the
// gateway then gone for good, --reconnect-max-attempts bounds `start`.
#[tokio::test(flavor = "multi_thread")]
async fn cli_start_reconnects_then_exits_after_max_reconnect_attempts() {
    let mut h = Harness::start(true, true).await;
    let socket = h.socket_path.to_string_lossy().into_owned();
    let cli = tokio::task::spawn_blocking(move || {
        run_actor_worker_cli(
            registrations(),
            [
                "start",
                "--gateway-socket",
                socket.as_str(),
                "--worker-id",
                "w-cli",
                "--reconnect-initial-delay-ms",
                "10",
                "--reconnect-max-attempts",
                "2",
            ],
            None,
        )
    });

    let session_request::Payload::Register(register) = h.next_of(is_register).await else {
        unreachable!()
    };
    assert_eq!(register.worker_id, "w-cli");
    h.next_of(is_register).await; // re-registered after the stream ended
    let _dir = h.crash();

    let code = tokio::time::timeout(TIMEOUT, cli)
        .await
        .expect("CLI didn't return")
        .unwrap();
    assert_eq!(code, 1);
}

// A handler still blocking when the worker gives up mustn't keep the CLI (and
// so the process) from exiting: run_actor_worker_cli doesn't wait for the
// runtime's blocking threads.
#[tokio::test(flavor = "multi_thread")]
async fn cli_exits_without_waiting_for_a_stuck_handler() {
    let h = Harness::start(true, false).await;
    let socket = h.socket_path.to_string_lossy().into_owned();
    let started = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stuck = {
        let started = started.clone();
        ActorRegistration::new(
            "creditCheck",
            "v01",
            "internalAsyncOperation",
            "stuck",
            "v01",
            "rust",
            move |_input: Value| {
                started.store(true, std::sync::atomic::Ordering::SeqCst);
                std::thread::sleep(Duration::from_secs(60));
                Value::Null
            },
        )
    };
    let cli = tokio::task::spawn_blocking(move || {
        run_actor_worker_cli(
            vec![stuck],
            [
                "start",
                "--gateway-socket",
                socket.as_str(),
                "--reconnect-initial-delay-ms",
                "10",
                "--reconnect-max-attempts",
                "1",
            ],
            None,
        )
    });
    let mut h = h;
    h.next_of(is_register).await;
    h.invoke("i-stuck", "stuck", json!(null));
    while !started.load(std::sync::atomic::Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let _dir = h.crash();

    let code = tokio::time::timeout(TIMEOUT, cli)
        .await
        .expect("CLI waited for the stuck handler")
        .unwrap();
    assert_eq!(code, 1);
}

// Reconnect (#392): the worker waits for a gateway that isn't up yet,
// re-registers after the gateway restarts, and only gives up when told to.

async fn stop_and_wait(worker: &ActorWorker, running: JoinHandle<Result<(), String>>) {
    worker.stop();
    let result = tokio::time::timeout(TIMEOUT, running)
        .await
        .expect("run() didn't return after stop()");
    assert_eq!(result.unwrap(), Ok(()));
}

fn spawn_run(worker: &Arc<ActorWorker>) -> JoinHandle<Result<(), String>> {
    let w = worker.clone();
    tokio::spawn(async move { w.run().await.map_err(|e| e.to_string()) })
}

#[tokio::test(flavor = "multi_thread")]
async fn waits_for_a_gateway_that_starts_after_it() {
    let dir = temp_dir();
    let worker = worker(&dir.path().join("gw.sock"));
    let running = spawn_run(&worker);
    // A few attempts fail against the missing socket.
    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut h = Harness::serve(dir, true, false);
    h.next_of(is_register).await;
    h.invoke("inv-early", "checkBureau", json!({ "n": 1 }));
    h.next_of(is_invoke_result).await;
    stop_and_wait(&worker, running).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn re_registers_after_the_gateway_restarts() {
    let mut first = Harness::start(true, false).await;
    let worker = worker(&first.socket_path);
    let running = spawn_run(&worker);
    first.next_of(is_register).await;
    let dir = first.crash();

    let mut second = Harness::serve(dir, true, false);
    let session_request::Payload::Register(register) = second.next_of(is_register).await else {
        unreachable!()
    };
    assert_eq!(register.worker_id, "w-test");
    second.invoke("inv-restart", "checkBureau", json!({ "n": 2 }));
    let session_request::Payload::InvokeResult(result) = second.next_of(is_invoke_result).await
    else {
        unreachable!()
    };
    assert_eq!(result.invoke_id, "inv-restart");
    stop_and_wait(&worker, running).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn gives_up_after_max_reconnect_attempts() {
    let worker = ActorWorker::new(
        ActorWorkerOptions {
            worker_id: "w-none".into(),
            gateway_socket_path: "/nonexistent/gw.sock".into(),
            reconnect_initial_delay_ms: 10,
            reconnect_max_delay_ms: 50,
            reconnect_max_attempts: 3,
            ..Default::default()
        },
        registrations(),
    );
    let err = tokio::time::timeout(TIMEOUT, worker.run())
        .await
        .expect("run() didn't return")
        .unwrap_err();
    assert!(
        err.to_string()
            .contains("giving up after 3 consecutive failed attempt"),
        "{}",
        err
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_interrupts_the_reconnect_backoff() {
    let worker = Arc::new(ActorWorker::new(
        ActorWorkerOptions {
            worker_id: "w-stop".into(),
            gateway_socket_path: "/nonexistent/gw.sock".into(),
            reconnect_initial_delay_ms: 60_000,
            reconnect_max_delay_ms: 60_000,
            ..Default::default()
        },
        registrations(),
    ));
    let running = spawn_run(&worker);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let started = std::time::Instant::now();
    stop_and_wait(&worker, running).await;
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn reconnect_delay_is_full_jitter_under_the_capped_exponential() {
    for attempt in 1..=12u32 {
        let ceiling = (250u64 << (attempt - 1)).min(30_000);
        for _ in 0..50 {
            let delay = reconnect_delay_ms(attempt, 250, 30_000);
            assert!(delay < ceiling, "attempt {attempt}: {delay} >= {ceiling}");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn fails_fast_on_unauthenticated() {
    let h = Harness::start_aborting(tonic::Code::Unauthenticated);
    let worker = worker(&h.socket_path);
    let err = tokio::time::timeout(TIMEOUT, worker.run())
        .await
        .expect("run() didn't return")
        .unwrap_err();
    let status = err.downcast_ref::<Status>().expect("a gRPC status");
    assert_eq!(status.code(), tonic::Code::Unauthenticated);
    assert_eq!(h.sessions(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn flapping_gateway_counts_toward_reconnect_max_attempts() {
    let h = Harness::start(true, true).await;
    let worker = ActorWorker::new(
        ActorWorkerOptions {
            worker_id: "w-flap".into(),
            gateway_socket_path: h.socket_path.to_string_lossy().into_owned(),
            reconnect_initial_delay_ms: 10,
            reconnect_max_delay_ms: 50,
            reconnect_max_attempts: 3,
            ..Default::default()
        },
        registrations(),
    );
    let err = tokio::time::timeout(TIMEOUT, worker.run())
        .await
        .expect("run() didn't return")
        .unwrap_err();
    assert!(
        err.to_string()
            .contains("giving up after 3 consecutive failed attempt"),
        "{}",
        err
    );
    assert_eq!(h.sessions(), 3);
}
