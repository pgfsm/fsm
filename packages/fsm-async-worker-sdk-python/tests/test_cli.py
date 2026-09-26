from __future__ import annotations

from pgfsm.async_worker_sdk import run_actor_worker_cli

REGISTRATIONS = [
    {
        "parent_fsm_name": "creditCheck",
        "parent_fsm_version": "v01",
        "async_operation_type": "fsm",
        "async_operation_name": "checkBureau",
        "async_operation_version": "v01",
        "async_operation_language": "python",
        "handler": lambda _input: None,
    }
]


def test_help_exits_0() -> None:
    assert run_actor_worker_cli(REGISTRATIONS, ["--help"]) == 0


def test_list_exits_0_without_connecting() -> None:
    assert run_actor_worker_cli(REGISTRATIONS, ["list", "--gateway-socket", "/nonexistent.sock"]) == 0


def test_missing_or_unknown_command_exits_1() -> None:
    assert run_actor_worker_cli(REGISTRATIONS, []) == 1
    assert run_actor_worker_cli(REGISTRATIONS, ["serve"]) == 1


def test_start_with_empty_registry_exits_1() -> None:
    assert run_actor_worker_cli([], ["start"]) == 1


def test_start_against_missing_socket_exits_1() -> None:
    # grpc surfaces the connection failure from the first read of the stream.
    assert run_actor_worker_cli(REGISTRATIONS, ["start", "--gateway-socket", "/nonexistent/gw.sock"]) == 1
