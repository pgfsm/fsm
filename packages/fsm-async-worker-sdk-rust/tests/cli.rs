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

#[test]
fn start_against_missing_socket_exits_1() {
    assert_eq!(
        run(&["start", "--gateway-socket", "/nonexistent/gw.sock"]),
        1
    );
}
