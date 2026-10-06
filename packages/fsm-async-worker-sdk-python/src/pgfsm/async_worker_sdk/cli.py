"""`list`/`start` command handling for a compiler-generated
`run_async_worker.py` — moved here from fsm-compiler-ts's
python/worker-sdk-cli.eta (#364), which used to write this whole file into
every project as `async-worker/python/cli.py`.

Python counterpart of @pgfsm/async-worker-sdk's runActorWorkerCli. Logging is
not configured here; the generated entry point configures it once before
calling this.
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import threading
import uuid
from dataclasses import dataclass
from typing import Dict, List, Mapping, Optional, Sequence

from .actor_worker import (
    DEFAULT_HEARTBEAT_MS,
    DEFAULT_KEEPALIVE_INTERVAL_MS,
    DEFAULT_KEEPALIVE_TIMEOUT_MS,
    DEFAULT_RECONNECT_INITIAL_DELAY_MS,
    DEFAULT_RECONNECT_MAX_DELAY_MS,
    DEFAULT_SHUTDOWN_GRACE_MS,
    ActorRegistration,
    ActorWorker,
    parse_gateway_address,
)

logger = logging.getLogger("pgfsm.async_worker_sdk.cli")

DEFAULT_GATEWAY_SOCKET_PATH = "/tmp/pgfsm-activity-gateway-workers.sock"

_DESCRIPTION = """\
pgfsm-async-worker-sdk — Python worker for the Activity Gateway

commands:
  list    Print the actors compiled into this registry, without connecting to the gateway.
  start   Connect to the gateway and serve invocations for every actor in the registry until stopped.
          Waits for the gateway if it isn't up yet, and reconnects and re-registers if the
          session drops (e.g. the gateway restarts). On SIGINT/SIGTERM it drains: new invokes
          are refused as retriable while in-flight ones finish.

environment:
  Every option except --help falls back to an environment variable when the flag isn't
  given: PGFSM_ + the long name in upper case, with - as _. A flag wins over its variable;
  an empty variable counts as unset. Credentials stay file paths.
    PGFSM_GATEWAY_SOCKET
    PGFSM_GATEWAY_ADDRESS
    PGFSM_GATEWAY_CA_FILE
    PGFSM_GATEWAY_TOKEN_FILE
    PGFSM_GATEWAY_CERT_FILE
    PGFSM_GATEWAY_KEY_FILE
    PGFSM_MAX_CONCURRENCY
    PGFSM_KEEPALIVE_INTERVAL_MS
    PGFSM_KEEPALIVE_TIMEOUT_MS
    PGFSM_SHUTDOWN_GRACE_MS
    PGFSM_WORKER_ID
    PGFSM_HEARTBEAT_MS
    PGFSM_RECONNECT_INITIAL_DELAY_MS
    PGFSM_RECONNECT_MAX_DELAY_MS
    PGFSM_RECONNECT_MAX_ATTEMPTS

Actors come from a compiler-generated registry (see fsm-compiler-ts's
writeAggregateActorsRegistry) -- statically imported, not scanned or
dynamically loaded at startup.
"""


# The options that fall back to an environment variable, by long name. Same
# list, names and precedence (flag -> variable -> default) in all four SDKs.
ENV_OPTIONS = (
    "gateway-socket",
    "gateway-address",
    "gateway-ca-file",
    "gateway-token-file",
    "gateway-cert-file",
    "gateway-key-file",
    "max-concurrency",
    "keepalive-interval-ms",
    "keepalive-timeout-ms",
    "shutdown-grace-ms",
    "worker-id",
    "heartbeat-ms",
    "reconnect-initial-delay-ms",
    "reconnect-max-delay-ms",
    "reconnect-max-attempts",
)


def env_var_for(option: str) -> str:
    """`PGFSM_` + the long option name upper-cased, `-` -> `_`."""
    return "PGFSM_" + option.upper().replace("-", "_")


@dataclass
class CliSettings:
    """Everything `start` needs, resolved from flags, then variables, then
    defaults."""

    gateway_address: str
    ca_file: Optional[str] = None
    token_file: Optional[str] = None
    cert_file: Optional[str] = None
    key_file: Optional[str] = None
    max_concurrency: Optional[int] = None
    keepalive_interval_ms: int = DEFAULT_KEEPALIVE_INTERVAL_MS
    keepalive_timeout_ms: int = DEFAULT_KEEPALIVE_TIMEOUT_MS
    shutdown_grace_ms: int = DEFAULT_SHUTDOWN_GRACE_MS
    worker_id: Optional[str] = None
    heartbeat_ms: int = DEFAULT_HEARTBEAT_MS
    reconnect_initial_delay_ms: int = DEFAULT_RECONNECT_INITIAL_DELAY_MS
    reconnect_max_delay_ms: int = DEFAULT_RECONNECT_MAX_DELAY_MS
    reconnect_max_attempts: int = 0


def resolve_settings(
    flags: Mapping[str, Optional[str]], env: Mapping[str, str]
) -> CliSettings:
    """Resolves the options from flags (long name -> raw string, None when not
    given) and the environment: a flag wins over its variable, which wins over
    the default. An empty variable counts as unset. Raises ValueError, naming
    the flag or variable a bad value came from, so `start` can exit 1 before
    connecting."""

    def from_env(option: str) -> Optional[str]:
        return env.get(env_var_for(option)) or None

    def setting(option: str) -> Optional["tuple[str, str]"]:
        """(raw value, where it came from), or None when unset."""
        if flags.get(option) is not None:
            return flags[option], f"--{option}"  # type: ignore[return-value]
        value = from_env(option)
        return None if value is None else (value, env_var_for(option))

    def integer(option: str, minimum: int) -> Optional[int]:
        found = setting(option)
        if found is None:
            return None
        raw, label = found
        try:
            value = int(raw.strip())
        except ValueError:
            value = None
        if value is None or value < minimum:
            raise ValueError(f"{label} must be an integer >= {minimum}, got: {raw}")
        return value

    # Where the gateway is counts as one setting: a flag for either form
    # overrides both variables.
    from_flags = flags.get("gateway-socket") is not None or flags.get("gateway-address") is not None
    if from_flags:
        socket, address = flags.get("gateway-socket"), flags.get("gateway-address")
    else:
        socket, address = from_env("gateway-socket"), from_env("gateway-address")
    if socket and address:
        if from_flags:
            raise ValueError("Pass either --gateway-socket or --gateway-address, not both")
        raise ValueError(
            f"Set either {env_var_for('gateway-socket')} or "
            f"{env_var_for('gateway-address')}, not both"
        )
    if address:
        parse_gateway_address(address)  # ValueError names the address
        gateway_address = address
    else:
        gateway_address = f"unix:{socket or DEFAULT_GATEWAY_SOCKET_PATH}"

    files = {
        name: setting(f"gateway-{name}")
        for name in ("ca-file", "token-file", "cert-file", "key-file")
    }
    if (files["cert-file"] is None) != (files["key-file"] is None):
        raise ValueError(
            "--gateway-cert-file and --gateway-key-file go together (or "
            f"{env_var_for('gateway-cert-file')} and {env_var_for('gateway-key-file')})"
        )
    # Fail fast on unreadable credentials instead of retrying forever.
    for found in files.values():
        if found is not None and not (os.path.isfile(found[0]) and os.access(found[0], os.R_OK)):
            raise ValueError(f"Can't read {found[1]} file {found[0]}")

    settings = CliSettings(gateway_address=gateway_address)
    for name, found in files.items():
        if found is not None:
            setattr(settings, name.replace("-", "_"), found[0])
    worker_id = setting("worker-id")
    settings.worker_id = worker_id[0] if worker_id else None
    for option, minimum in (
        ("max-concurrency", 1),
        ("keepalive-interval-ms", 0),
        ("keepalive-timeout-ms", 1),
        ("shutdown-grace-ms", 0),
        ("heartbeat-ms", 1),
        ("reconnect-initial-delay-ms", 1),
        ("reconnect-max-delay-ms", 1),
        ("reconnect-max-attempts", 0),
    ):
        value = integer(option, minimum)
        if value is not None:
            setattr(settings, option.replace("-", "_"), value)
    return settings


class _UsageError(Exception):
    pass


class _ArgumentParser(argparse.ArgumentParser):
    """Raises instead of calling sys.exit(), so run_actor_worker_cli can turn a
    usage error into an exit code."""

    def error(self, message: str) -> None:  # type: ignore[override]
        raise _UsageError(message)


def _build_parser(invocation: str) -> _ArgumentParser:
    parser = _ArgumentParser(
        prog=invocation,
        description=_DESCRIPTION,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "examples:\n"
            f"  {invocation} start --gateway-socket {DEFAULT_GATEWAY_SOCKET_PATH}\n"
            f"  {invocation} start --gateway-address https://activity-gateway:7443 \\\n"
            "    --gateway-ca-file ca.crt --gateway-token-file token --max-concurrency 10"
        ),
        add_help=False,
    )
    parser.add_argument("command", nargs="?", choices=["list", "start"])
    parser.add_argument(
        "-g",
        "--gateway-socket",
        default=None,
        help=f"Sidecar socket to connect to (default: {DEFAULT_GATEWAY_SOCKET_PATH})",
    )
    parser.add_argument(
        "-a",
        "--gateway-address",
        default=None,
        help=(
            "Gateway sidecar address instead: unix:<path>, https://host:port, "
            "or http://host:port (the gateway's --insecure-plaintext test mode)"
        ),
    )
    parser.add_argument(
        "--gateway-ca-file",
        default=None,
        help="PEM CA bundle to trust the gateway's TLS certificate (default: system roots)",
    )
    parser.add_argument(
        "--gateway-token-file",
        default=None,
        help="Bearer token sent to the gateway; re-read on every reconnect",
    )
    parser.add_argument(
        "--gateway-cert-file",
        default=None,
        help="Client certificate for mutual TLS (with --gateway-key-file)",
    )
    parser.add_argument(
        "--gateway-key-file",
        default=None,
        help="Client key for mutual TLS (with --gateway-cert-file)",
    )
    parser.add_argument(
        "-c",
        "--max-concurrency",
        default=None,
        help=(
            "Invokes of each actor run at once, for actors without their own "
            "max_concurrency (default: 1). Handlers must be concurrency-safe above 1."
        ),
    )
    parser.add_argument(
        "--keepalive-interval-ms",
        default=None,
        help=f"HTTP/2 PING interval over TCP (default: {DEFAULT_KEEPALIVE_INTERVAL_MS}; 0 disables)",
    )
    parser.add_argument(
        "--keepalive-timeout-ms",
        default=None,
        help=f"Reconnect when a PING goes unanswered this long (default: {DEFAULT_KEEPALIVE_TIMEOUT_MS})",
    )
    parser.add_argument(
        "--shutdown-grace-ms",
        default=None,
        help=(
            "On SIGINT/SIGTERM, let in-flight invokes finish this long "
            f"(default: {DEFAULT_SHUTDOWN_GRACE_MS})"
        ),
    )
    parser.add_argument(
        "-i",
        "--worker-id",
        default=None,
        help="Stable worker identity (default: python-<random>)",
    )
    parser.add_argument(
        "--heartbeat-ms",
        default=None,
        help=f"Heartbeat interval (default: {DEFAULT_HEARTBEAT_MS})",
    )
    parser.add_argument(
        "--reconnect-initial-delay-ms",
        default=None,
        help=f"First reconnect backoff step (default: {DEFAULT_RECONNECT_INITIAL_DELAY_MS})",
    )
    parser.add_argument(
        "--reconnect-max-delay-ms",
        default=None,
        help=f"Reconnect backoff cap (default: {DEFAULT_RECONNECT_MAX_DELAY_MS})",
    )
    parser.add_argument(
        "--reconnect-max-attempts",
        default=None,
        help="Exit after n consecutive failed attempts (default: 0 = retry forever)",
    )
    parser.add_argument(
        "-h", "--help", action="store_true", help="Show this help message"
    )
    return parser


def run_actor_worker_cli(
    registrations: List[ActorRegistration],
    args: Sequence[str],
    invocation: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
) -> int:
    """Runs the `list`/`start` worker CLI against `registrations` and returns
    the process exit code — the caller decides whether to exit with it, which
    keeps this testable. `start` installs SIGINT/SIGTERM handlers (when called
    from the main thread) that stop the worker gracefully, and restores the
    previous handlers once it returns.

    `invocation` is how to run the calling script, shown in `--help`; defaults
    to `python3 run_async_worker.py`. Every option falls back to its
    environment variable (see `env_var_for`), read from `env` (default
    `os.environ`).
    """
    parser = _build_parser(invocation or "python3 run_async_worker.py")

    try:
        parsed = parser.parse_args(list(args))
    except _UsageError as exc:
        logger.error("%s", exc)
        print(parser.format_help())
        return 1

    if parsed.help:
        print(parser.format_help())
        return 0

    if parsed.command is None:
        logger.error("First argument must be one of: list, start. Got: (none)")
        print(parser.format_help())
        return 1

    flags: Dict[str, Optional[str]] = {
        option: getattr(parsed, option.replace("-", "_")) for option in ENV_OPTIONS
    }
    try:
        settings = resolve_settings(flags, os.environ if env is None else env)
    except ValueError as exc:
        logger.error("%s", exc)
        return 1
    gateway_address = settings.gateway_address

    worker_id: str = settings.worker_id or f"python-{uuid.uuid4().hex[:8]}"

    logger.info("%d actor(s) compiled into this registry", len(registrations))
    for reg in registrations:
        logger.info(
            "  + %s@%s (parent %s@%s)",
            reg["async_operation_name"],
            reg["async_operation_version"],
            reg["parent_fsm_name"],
            reg["parent_fsm_version"],
        )

    if parsed.command == "list":
        return 0

    if not registrations:
        logger.error("No actors in the registry, refusing to start worker")
        return 1

    worker = ActorWorker(
        worker_id=worker_id,
        registrations=registrations,
        heartbeat_ms=settings.heartbeat_ms,
        reconnect_initial_delay_ms=settings.reconnect_initial_delay_ms,
        reconnect_max_delay_ms=settings.reconnect_max_delay_ms,
        reconnect_max_attempts=settings.reconnect_max_attempts,
        gateway_address=gateway_address,
        ca_file=settings.ca_file,
        token_file=settings.token_file,
        cert_file=settings.cert_file,
        key_file=settings.key_file,
        keepalive_interval_ms=settings.keepalive_interval_ms,
        keepalive_timeout_ms=settings.keepalive_timeout_ms,
        max_concurrency=settings.max_concurrency,
        shutdown_grace_ms=settings.shutdown_grace_ms,
    )

    stop_requested = False

    def _on_signal(signum: int, frame: object) -> None:
        nonlocal stop_requested
        del signum, frame
        if stop_requested:
            logger.info("Already stopping: waiting for in-flight invokes to finish")
            return
        stop_requested = True
        logger.info("Shutdown requested — draining and stopping worker...")
        worker.stop()

    # signal.signal() only works from the main thread; elsewhere (e.g. a test
    # driving this from a worker thread) the caller stops the worker itself.
    previous_handlers = {}
    if threading.current_thread() is threading.main_thread():
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[sig] = signal.signal(sig, _on_signal)

    try:
        logger.info("Starting worker %s: gateway=%s", worker_id, gateway_address)
        worker.run()
        logger.info("Worker %s stopped.", worker_id)
        return 0
    except Exception as exc:  # noqa: BLE001 — reported and turned into an exit code
        logger.error("Worker %s failed: %s", worker_id, exc, exc_info=True)
        return 1
    finally:
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)
