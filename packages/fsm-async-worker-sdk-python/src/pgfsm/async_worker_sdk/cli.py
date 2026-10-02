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
from typing import List, Optional, Sequence

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

Actors come from a compiler-generated registry (see fsm-compiler-ts's
writeAggregateActorsRegistry) -- statically imported, not scanned or
dynamically loaded at startup.
"""


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
        type=int,
        default=None,
        help=(
            "Invokes of each actor run at once, for actors without their own "
            "max_concurrency (default: 1). Handlers must be concurrency-safe above 1."
        ),
    )
    parser.add_argument(
        "--keepalive-interval-ms",
        type=int,
        default=DEFAULT_KEEPALIVE_INTERVAL_MS,
        help=f"HTTP/2 PING interval over TCP (default: {DEFAULT_KEEPALIVE_INTERVAL_MS}; 0 disables)",
    )
    parser.add_argument(
        "--keepalive-timeout-ms",
        type=int,
        default=DEFAULT_KEEPALIVE_TIMEOUT_MS,
        help=f"Reconnect when a PING goes unanswered this long (default: {DEFAULT_KEEPALIVE_TIMEOUT_MS})",
    )
    parser.add_argument(
        "--shutdown-grace-ms",
        type=int,
        default=DEFAULT_SHUTDOWN_GRACE_MS,
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
        type=int,
        default=DEFAULT_HEARTBEAT_MS,
        help=f"Heartbeat interval (default: {DEFAULT_HEARTBEAT_MS})",
    )
    parser.add_argument(
        "--reconnect-initial-delay-ms",
        type=int,
        default=DEFAULT_RECONNECT_INITIAL_DELAY_MS,
        help=f"First reconnect backoff step (default: {DEFAULT_RECONNECT_INITIAL_DELAY_MS})",
    )
    parser.add_argument(
        "--reconnect-max-delay-ms",
        type=int,
        default=DEFAULT_RECONNECT_MAX_DELAY_MS,
        help=f"Reconnect backoff cap (default: {DEFAULT_RECONNECT_MAX_DELAY_MS})",
    )
    parser.add_argument(
        "--reconnect-max-attempts",
        type=int,
        default=0,
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
) -> int:
    """Runs the `list`/`start` worker CLI against `registrations` and returns
    the process exit code — the caller decides whether to exit with it, which
    keeps this testable. `start` installs SIGINT/SIGTERM handlers (when called
    from the main thread) that stop the worker gracefully, and restores the
    previous handlers once it returns.

    `invocation` is how to run the calling script, shown in `--help`; defaults
    to `python3 run_async_worker.py`.
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

    if parsed.gateway_socket and parsed.gateway_address:
        logger.error("Pass either --gateway-socket or --gateway-address, not both")
        return 1
    gateway_address: str = parsed.gateway_address or (
        f"unix:{parsed.gateway_socket or DEFAULT_GATEWAY_SOCKET_PATH}"
    )
    try:
        parse_gateway_address(gateway_address)
    except ValueError as exc:
        logger.error("%s", exc)
        return 1
    if bool(parsed.gateway_cert_file) != bool(parsed.gateway_key_file):
        logger.error("--gateway-cert-file and --gateway-key-file go together")
        return 1
    # Fail fast on unreadable credentials instead of retrying forever.
    for flag, path in (
        ("--gateway-ca-file", parsed.gateway_ca_file),
        ("--gateway-token-file", parsed.gateway_token_file),
        ("--gateway-cert-file", parsed.gateway_cert_file),
        ("--gateway-key-file", parsed.gateway_key_file),
    ):
        if path and not (os.path.isfile(path) and os.access(path, os.R_OK)):
            logger.error("Can't read %s file %s", flag, path)
            return 1
    for flag, value, minimum in (
        ("--max-concurrency", parsed.max_concurrency, 1),
        ("--keepalive-interval-ms", parsed.keepalive_interval_ms, 0),
        ("--keepalive-timeout-ms", parsed.keepalive_timeout_ms, 1),
        ("--shutdown-grace-ms", parsed.shutdown_grace_ms, 0),
    ):
        if value is not None and value < minimum:
            logger.error("%s must be an integer >= %d, got: %d", flag, minimum, value)
            return 1

    worker_id: str = parsed.worker_id or f"python-{uuid.uuid4().hex[:8]}"

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
        heartbeat_ms=parsed.heartbeat_ms,
        reconnect_initial_delay_ms=parsed.reconnect_initial_delay_ms,
        reconnect_max_delay_ms=parsed.reconnect_max_delay_ms,
        reconnect_max_attempts=parsed.reconnect_max_attempts,
        gateway_address=gateway_address,
        ca_file=parsed.gateway_ca_file,
        token_file=parsed.gateway_token_file,
        cert_file=parsed.gateway_cert_file,
        key_file=parsed.gateway_key_file,
        keepalive_interval_ms=parsed.keepalive_interval_ms,
        keepalive_timeout_ms=parsed.keepalive_timeout_ms,
        max_concurrency=parsed.max_concurrency,
        shutdown_grace_ms=parsed.shutdown_grace_ms,
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
