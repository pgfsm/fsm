//! `run_actor_worker_cli`'s exit codes — same cases as the Python SDK's
//! test_cli.py. None of these reach a gateway.

use pgfsm_async_worker_sdk::{run_actor_worker_cli, ActorRegistration};
use serde_json::Value;

fn registrations() -> Vec<ActorRegistration> {
    vec![ActorRegistration::new(
        "creditCheck",
        "v01",
        "internalAsyncOperation",
        "checkBureau",
        "v01",
        "rust",
        |_input: Value| Value::Null,
    )]
}

fn run(args: &[&str]) -> i32 {
    run_actor_worker_cli(registrations(), args.iter().copied(), None)
}

#[test]
fn help_exits_0() {
    assert_eq!(run(&["--help"]), 0);
}

#[test]
fn list_exits_0_without_connecting() {
    assert_eq!(run(&["list", "--gateway-socket", "/nonexistent.sock"]), 0);
}

#[test]
fn missing_or_unknown_command_exits_1() {
    assert_eq!(run(&[]), 1);
    assert_eq!(run(&["serve"]), 1);
}

#[test]
fn start_with_empty_registry_exits_1() {
    assert_eq!(run_actor_worker_cli(Vec::new(), ["start"], None), 1);
}

// Without --reconnect-max-attempts the worker would wait for the gateway
// forever (#392).
#[test]
fn start_against_missing_socket_exits_1_after_max_reconnect_attempts() {
    assert_eq!(
        run(&[
            "start",
            "--gateway-socket",
            "/nonexistent/gw.sock",
            "--reconnect-initial-delay-ms",
            "5",
            "--reconnect-max-attempts",
            "2",
        ]),
        1
    );
}

// Flag validation (SPEC-007): bad flags exit 1 before connecting, instead of
// retrying forever against a misconfiguration.

#[test]
fn bad_tcp_flags_exit_1() {
    for args in [
        &["start", "-g", "/tmp/x.sock", "-a", "unix:/tmp/y.sock"][..],
        &["start", "--gateway-address", "tcp://gw:1"],
        &[
            "start",
            "-a",
            "https://gw:7443",
            "--gateway-cert-file",
            "c.crt",
        ],
        &["start", "--max-concurrency", "0"],
        &["start", "--keepalive-timeout-ms", "0"],
    ] {
        assert_eq!(run(args), 1, "{:?}", args);
    }
}

#[test]
fn unreadable_credential_files_exit_1() {
    for flag in ["--gateway-ca-file", "--gateway-token-file"] {
        assert_eq!(
            run(&["start", "-a", "https://gw:7443", flag, "/nonexistent/file"]),
            1,
            "{}",
            flag
        );
    }
}

#[test]
fn list_accepts_the_tcp_flags() {
    let dir = tempfile::tempdir().unwrap();
    let token = dir.path().join("token");
    std::fs::write(&token, "t").unwrap();
    assert_eq!(
        run(&[
            "list",
            "-a",
            "https://gw:7443",
            "--gateway-token-file",
            token.to_str().unwrap(),
            "-c",
            "4",
            "--keepalive-interval-ms",
            "0",
        ]),
        0
    );
}
