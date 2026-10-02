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


def test_start_against_missing_socket_exits_1_after_max_reconnect_attempts() -> None:
    # Without --reconnect-max-attempts the worker would wait for the gateway
    # forever (#392).
    args = [
        "start",
        "--gateway-socket",
        "/nonexistent/gw.sock",
        "--reconnect-initial-delay-ms",
        "5",
        "--reconnect-max-attempts",
        "2",
    ]
    assert run_actor_worker_cli(REGISTRATIONS, args) == 1


# Flag validation (SPEC-007): bad flags exit 1 before connecting, instead of
# retrying forever against a misconfiguration.


def test_gateway_socket_and_address_together_exit_1() -> None:
    args = ["start", "--gateway-socket", "/tmp/x.sock", "--gateway-address", "unix:/tmp/y.sock"]
    assert run_actor_worker_cli(REGISTRATIONS, args) == 1


def test_bad_gateway_address_exits_1() -> None:
    for bad in ("tcp://gw:1", "https://gw", "unix:"):
        assert run_actor_worker_cli(REGISTRATIONS, ["start", "--gateway-address", bad]) == 1


def test_cert_without_key_exits_1(tmp_path) -> None:
    cert = tmp_path / "client.crt"
    cert.write_text("x")
    args = ["start", "--gateway-address", "https://gw:7443", "--gateway-cert-file", str(cert)]
    assert run_actor_worker_cli(REGISTRATIONS, args) == 1


def test_unreadable_credential_files_exit_1() -> None:
    for flag in ("--gateway-ca-file", "--gateway-token-file"):
        args = ["start", "--gateway-address", "https://gw:7443", flag, "/nonexistent/file"]
        assert run_actor_worker_cli(REGISTRATIONS, args) == 1


def test_out_of_range_or_empty_integer_flags_exit_1() -> None:
    for flag, value in (
        ("--max-concurrency", "0"),
        ("--max-concurrency", "-1"),
        ("--max-concurrency", ""),
        ("--max-concurrency", "two"),
        ("--keepalive-interval-ms", "-1"),
        ("--keepalive-timeout-ms", "0"),
        ("--shutdown-grace-ms", "-5"),
    ):
        assert run_actor_worker_cli(REGISTRATIONS, ["start", flag, value]) == 1, (flag, value)


def test_list_accepts_the_tcp_flags(tmp_path) -> None:
    token = tmp_path / "token"
    token.write_text("t")
    args = [
        "list",
        "--gateway-address",
        "https://gw:7443",
        "--gateway-token-file",
        str(token),
        "--max-concurrency",
        "4",
        "--keepalive-interval-ms",
        "0",
    ]
    assert run_actor_worker_cli(REGISTRATIONS, args) == 0
