//! `ActorWorker` and the CLI's `start` path end to end against an in-process
//! `SidecarGatewayService` over a real Unix socket: register, invoke, a
//! panicking handler surfacing as INTERNAL, an unknown actor as NOT_FOUND,
//! unregister on stop, and a rejected registration.
//!
//! The fake gateway is a tonic server built from the same pgfsm-proto-codegen
//! stubs; it plays the gateway's side of the Session stream just far enough to
//! drive the worker. Same coverage as the Python SDK's test_actor_worker.py.

use pgfsm_async_worker_sdk::{
    run_actor_worker_cli, ActorRegistration, ActorWorker, ActorWorkerOptions,
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
use tokio::sync::mpsc;
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
    to_worker: Mutex<Option<mpsc::UnboundedReceiver<SessionResponse>>>,
    from_worker: mpsc::UnboundedSender<SessionRequest>,
}

#[tonic::codegen::async_trait]
impl SidecarGatewayService for FakeGateway {
    type SessionStream = UnboundedReceiverStream<Result<SessionResponse, Status>>;

    async fn session(
        &self,
        request: Request<Streaming<SessionRequest>>,
    ) -> Result<Response<Self::SessionStream>, Status> {
        let mut inbound = request.into_inner();
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let mut to_worker = self.to_worker.lock().unwrap().take();
        let from_worker = self.from_worker.clone();
        let accept = self.accept;
        let close_after_ack = self.close_after_ack;

        tokio::spawn(async move {
            let mut out_tx = Some(out_tx);
            loop {
                tokio::select! {
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
    _dir: tempfile::TempDir,
}

impl Harness {
    async fn start(accept: bool, close_after_ack: bool) -> Self {
        // AF_UNIX paths are capped at ~104 bytes on macOS, so keep it short.
        let dir = tempfile::Builder::new()
            .prefix("pgfsm-")
            .tempdir_in("/tmp")
            .unwrap();
        let socket_path = dir.path().join("gw.sock");
        let (to_worker_tx, to_worker_rx) = mpsc::unbounded_channel();
        let (from_worker_tx, from_worker_rx) = mpsc::unbounded_channel();
        let gateway = FakeGateway {
            accept,
            close_after_ack,
            to_worker: Mutex::new(Some(to_worker_rx)),
            from_worker: from_worker_tx,
        };
        let listener = UnixListener::bind(&socket_path).unwrap();
        tokio::spawn(async move {
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
    assert!(err.to_string().contains("rejected"), "{}", err);
}

#[tokio::test(flavor = "multi_thread")]
async fn empty_registry_refuses_to_run() {
    let worker = ActorWorker::new(
        ActorWorkerOptions {
            worker_id: "w-empty".into(),
            gateway_socket_path: "/nonexistent/gw.sock".into(),
            heartbeat_ms: 50,
        },
        vec![],
    );
    assert!(worker.run().await.is_err());
}

// The CLI builds its own runtime, so it runs on a blocking thread here while
// the fake gateway lives on the test's runtime. The gateway ends the stream
// right after acking, so `start` returns on its own with exit code 0.
#[tokio::test(flavor = "multi_thread")]
async fn cli_start_serves_until_the_gateway_ends_the_stream() {
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
            ],
            None,
        )
    });

    let session_request::Payload::Register(register) = h
        .next_of(|p| matches!(p, session_request::Payload::Register(_)))
        .await
    else {
        unreachable!()
    };
    assert_eq!(register.worker_id, "w-cli");

    let code = tokio::time::timeout(TIMEOUT, cli)
        .await
        .expect("CLI didn't return")
        .unwrap();
    assert_eq!(code, 0);
}
