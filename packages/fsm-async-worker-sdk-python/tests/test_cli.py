from __future__ import annotations

import pytest

from pgfsm.async_worker_sdk import ENV_OPTIONS, env_var_for, resolve_settings, run_actor_worker_cli

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


# Environment-variable fallbacks (#438): every option falls back to
# PGFSM_<LONG_NAME>; a flag wins over its variable; an empty variable counts
# as unset; invalid values are named by their variable.


def test_env_var_names_match_the_other_sdks() -> None:
    assert [env_var_for(o) for o in ENV_OPTIONS] == [
        "PGFSM_GATEWAY_SOCKET",
        "PGFSM_GATEWAY_ADDRESS",
        "PGFSM_GATEWAY_CA_FILE",
        "PGFSM_GATEWAY_TOKEN_FILE",
        "PGFSM_GATEWAY_CERT_FILE",
        "PGFSM_GATEWAY_KEY_FILE",
        "PGFSM_MAX_CONCURRENCY",
        "PGFSM_KEEPALIVE_INTERVAL_MS",
        "PGFSM_KEEPALIVE_TIMEOUT_MS",
        "PGFSM_SHUTDOWN_GRACE_MS",
        "PGFSM_WORKER_ID",
        "PGFSM_HEARTBEAT_MS",
        "PGFSM_RECONNECT_INITIAL_DELAY_MS",
        "PGFSM_RECONNECT_MAX_DELAY_MS",
        "PGFSM_RECONNECT_MAX_ATTEMPTS",
    ]


def test_every_option_comes_from_its_variable(tmp_path) -> None:
    for name in ("ca", "token", "cert", "key"):
        (tmp_path / name).write_text("x")
    s = resolve_settings(
        {},
        {
            "PGFSM_GATEWAY_ADDRESS": "https://gw:7443",
            "PGFSM_GATEWAY_CA_FILE": str(tmp_path / "ca"),
            "PGFSM_GATEWAY_TOKEN_FILE": str(tmp_path / "token"),
            "PGFSM_GATEWAY_CERT_FILE": str(tmp_path / "cert"),
            "PGFSM_GATEWAY_KEY_FILE": str(tmp_path / "key"),
            "PGFSM_MAX_CONCURRENCY": "10",
            "PGFSM_KEEPALIVE_INTERVAL_MS": "0",
            "PGFSM_KEEPALIVE_TIMEOUT_MS": "500",
            "PGFSM_SHUTDOWN_GRACE_MS": "1000",
            "PGFSM_WORKER_ID": "w-env",
            "PGFSM_HEARTBEAT_MS": "250",
            "PGFSM_RECONNECT_INITIAL_DELAY_MS": "5",
            "PGFSM_RECONNECT_MAX_DELAY_MS": "100",
            "PGFSM_RECONNECT_MAX_ATTEMPTS": "3",
        },
    )
    assert (s.gateway_address, s.ca_file, s.token_file, s.cert_file, s.key_file) == (
        "https://gw:7443",
        str(tmp_path / "ca"),
        str(tmp_path / "token"),
        str(tmp_path / "cert"),
        str(tmp_path / "key"),
    )
    assert (s.max_concurrency, s.keepalive_interval_ms, s.keepalive_timeout_ms, s.shutdown_grace_ms) == (
        10,
        0,
        500,
        1000,
    )
    assert (s.worker_id, s.heartbeat_ms, s.reconnect_initial_delay_ms) == ("w-env", 250, 5)
    assert (s.reconnect_max_delay_ms, s.reconnect_max_attempts) == (100, 3)


def test_a_flag_wins_and_an_empty_variable_is_unset() -> None:
    s = resolve_settings(
        {"max-concurrency": "2", "worker-id": "w-flag"},
        {
            "PGFSM_MAX_CONCURRENCY": "10",
            "PGFSM_WORKER_ID": "w-env",
            "PGFSM_SHUTDOWN_GRACE_MS": "",
            "PGFSM_GATEWAY_SOCKET": "/tmp/env.sock",
        },
    )
    assert (s.max_concurrency, s.worker_id) == (2, "w-flag")
    assert s.shutdown_grace_ms == 25000
    assert s.gateway_address == "unix:/tmp/env.sock"
    none = resolve_settings({}, {})
    assert none.gateway_address == "unix:/tmp/pgfsm-activity-gateway-workers.sock"
    assert none.max_concurrency is None and none.token_file is None


def test_a_gateway_flag_of_either_form_overrides_both_variables() -> None:
    env = {"PGFSM_GATEWAY_ADDRESS": "https://gw:7443"}
    assert resolve_settings({"gateway-socket": "/tmp/x.sock"}, env).gateway_address == "unix:/tmp/x.sock"
    with pytest.raises(ValueError, match="PGFSM_GATEWAY_SOCKET"):
        resolve_settings(
            {}, {"PGFSM_GATEWAY_SOCKET": "/tmp/x.sock", "PGFSM_GATEWAY_ADDRESS": "https://gw:7443"}
        )


@pytest.mark.parametrize(
    ("env", "named"),
    [
        ({"PGFSM_MAX_CONCURRENCY": "0"}, "PGFSM_MAX_CONCURRENCY"),
        ({"PGFSM_MAX_CONCURRENCY": "two"}, "PGFSM_MAX_CONCURRENCY"),
        ({"PGFSM_KEEPALIVE_TIMEOUT_MS": "0"}, "PGFSM_KEEPALIVE_TIMEOUT_MS"),
        ({"PGFSM_SHUTDOWN_GRACE_MS": "-1"}, "PGFSM_SHUTDOWN_GRACE_MS"),
        ({"PGFSM_HEARTBEAT_MS": "0"}, "PGFSM_HEARTBEAT_MS"),
        ({"PGFSM_RECONNECT_MAX_ATTEMPTS": "x"}, "PGFSM_RECONNECT_MAX_ATTEMPTS"),
        ({"PGFSM_GATEWAY_ADDRESS": "tcp://gw:1"}, "tcp://gw:1"),
        ({"PGFSM_GATEWAY_TOKEN_FILE": "/nonexistent/t"}, "PGFSM_GATEWAY_TOKEN_FILE"),
        ({"PGFSM_GATEWAY_CERT_FILE": "/tmp/c"}, "PGFSM_GATEWAY_KEY_FILE"),
    ],
)
def test_invalid_variables_are_reported_by_name(env, named) -> None:
    with pytest.raises(ValueError, match=named):
        resolve_settings({}, env)


def test_start_exits_1_on_an_invalid_variable_and_a_flag_overrides_it() -> None:
    env = {"PGFSM_MAX_CONCURRENCY": "zero"}
    assert run_actor_worker_cli(REGISTRATIONS, ["start"], env=env) == 1
    assert run_actor_worker_cli(REGISTRATIONS, ["list", "--max-concurrency", "3"], env=env) == 0
