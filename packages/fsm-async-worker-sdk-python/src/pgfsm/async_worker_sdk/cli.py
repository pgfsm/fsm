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
import signal
import threading
import uuid
from typing import List, Optional, Sequence

from .actor_worker import DEFAULT_HEARTBEAT_MS, ActorRegistration, ActorWorker

logger = logging.getLogger("pgfsm.async_worker_sdk.cli")

DEFAULT_GATEWAY_SOCKET_PATH = "/tmp/pgfsm-activity-gateway-workers.sock"

_DESCRIPTION = """\
pgfsm-async-worker-sdk — Python worker for the Activity Gateway

commands:
  list    Print the actors compiled into this registry, without connecting to the gateway.
  start   Connect to the gateway and serve invocations for every actor in the registry until stopped.

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
        epilog=f"example:\n  {invocation} start --gateway-socket {DEFAULT_GATEWAY_SOCKET_PATH}",
        add_help=False,
    )
    parser.add_argument("command", nargs="?", choices=["list", "start"])
    parser.add_argument(
        "-g",
        "--gateway-socket",
        default=DEFAULT_GATEWAY_SOCKET_PATH,
        help=f"Sidecar socket to connect to (default: {DEFAULT_GATEWAY_SOCKET_PATH})",
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

    gateway_socket_path: str = parsed.gateway_socket
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
        gateway_socket_path=gateway_socket_path,
        registrations=registrations,
        heartbeat_ms=parsed.heartbeat_ms,
    )

    def _on_signal(signum: int, frame: object) -> None:
        del signum, frame
        logger.info("Shutdown requested — stopping worker...")
        worker.stop()

    # signal.signal() only works from the main thread; elsewhere (e.g. a test
    # driving this from a worker thread) the caller stops the worker itself.
    previous_handlers = {}
    if threading.current_thread() is threading.main_thread():
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[sig] = signal.signal(sig, _on_signal)

    try:
        logger.info(
            "Starting worker %s: gateway-socket=%s", worker_id, gateway_socket_path
        )
        worker.run()
        logger.info("Worker %s stopped.", worker_id)
        return 0
    except Exception as exc:  # noqa: BLE001 — reported and turned into an exit code
        logger.error("Worker %s failed: %s", worker_id, exc, exc_info=True)
        return 1
    finally:
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)
