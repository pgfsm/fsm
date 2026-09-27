"""ActorWorker: the client end of the Activity Gateway's sidecar leg.

Moved here from fsm-compiler-ts's python/worker-sdk-sdk.eta (#364), which used
to write this whole module into every project as `async-worker/python/sdk.py`.

Connects to the gateway's sidecar Unix socket via the generated
pgfsm.sidecargateway.v1.SidecarGatewayService bidi-streaming client (from the
`pgfsm-proto-codegen` package), registers actors from a compiler-generated
registry, and serves invoke requests.

Python counterpart of @pgfsm/async-worker-sdk's ActorWorker — same actor_key()
identity (parent_fsm_name@parent_fsm_version@async_operation_type@async_operation_name@async_operation_version@
async_operation_language), same register -> heartbeat -> serve lifecycle.
Outgoing messages (register, heartbeat, invoke_result, invoke_error) are pushed
onto a thread-safe queue.Queue that doubles as the request generator grpc's
synchronous stream_stream stub drains on its own thread — the natural Python
analogue of @pgfsm/async-worker-sdk's push-based AsyncQueue, and a better fit
than a second manual reader/writer thread pair for the same duplex stream.

`ActorWorker` takes the registry's list of dicts (parent_fsm_name/
parent_fsm_version/async_operation_type/async_operation_name/
async_operation_version/async_operation_language/handler) directly; it stays
registry-source-agnostic so it's easy to test with a synthetic list. The
generated `run_async_worker.py` is what wires it to that project's registry,
via `run_actor_worker_cli` (see cli.py).

Logging is not configured here: this module only calls `logging.getLogger()`.
The generated entry point configures logging once.
"""

from __future__ import annotations

import asyncio
import json
import logging
import queue
import random
import threading
import time
from typing import Any, Callable, Dict, Iterator, List, Optional

import grpc
from pgfsm.sidecargateway.v1 import sidecar_gateway_pb2 as pb
from pgfsm.sidecargateway.v1 import sidecar_gateway_pb2_grpc as pb_grpc

logger = logging.getLogger("pgfsm.async_worker_sdk")

ActorHandler = Callable[[Any], Any]
ActorRegistration = Dict[str, Any]

DEFAULT_HEARTBEAT_MS = 5000
DEFAULT_RECONNECT_INITIAL_DELAY_MS = 250
DEFAULT_RECONNECT_MAX_DELAY_MS = 30000
# A session must stay up this long before the reconnect backoff resets, so a
# gateway that accepts and immediately drops (flapping) still backs off
# instead of being hammered in a tight loop.
STABLE_SESSION_MS = 10000

# gRPC codes that reconnecting can't fix (bad credentials, wrong server or
# protocol) -- run() fails fast on these rather than retrying forever and
# hiding a misconfiguration behind warnings. Same list in all four SDKs.
FATAL_STATUS_CODES = frozenset(
    {
        grpc.StatusCode.UNAUTHENTICATED,
        grpc.StatusCode.PERMISSION_DENIED,
        grpc.StatusCode.UNIMPLEMENTED,
        grpc.StatusCode.INVALID_ARGUMENT,
    }
)


class ProtocolError(Exception):
    pass


class RegistrationRejectedError(ProtocolError):
    """The gateway explicitly refused this worker's registration -- not
    retried, since reconnecting would just be refused again."""

    def __init__(self) -> None:
        super().__init__("gateway rejected registration")


def reconnect_delay_ms(attempt: int, initial_ms: int, max_ms: int) -> int:
    """Full-jitter exponential backoff (#392): a random delay in
    [0, min(max_ms, initial_ms * 2^(attempt-1))]. Same formula in all four
    SDKs."""
    ceiling = min(max_ms, initial_ms * 2 ** max(0, attempt - 1))
    return int(random.random() * ceiling)


def _is_fatal(error: BaseException) -> bool:
    if isinstance(error, RegistrationRejectedError):
        return True
    return isinstance(error, grpc.RpcError) and error.code() in FATAL_STATUS_CODES  # type: ignore[attr-defined]


class _Session:
    """Per-connection state: the outgoing queue grpc drains as the request
    stream, and whether the gateway acked this session's registration."""

    def __init__(self) -> None:
        self.outbox: "queue.Queue[Optional[pb.SessionRequest]]" = queue.Queue()
        self.registered = False
        self.done = threading.Event()


def actor_key(
    parent_fsm_name: str,
    parent_fsm_version: str,
    async_operation_type: str,
    async_operation_name: str,
    async_operation_version: str,
    async_operation_language: str,
) -> str:
    return (
        f"{parent_fsm_name}@{parent_fsm_version}@{async_operation_type}@{async_operation_name}"
        f"@{async_operation_version}@{async_operation_language}"
    )


def _parse_input_json(input_json: str) -> Any:
    if not input_json.strip():
        return None
    return json.loads(input_json)


class ActorWorker:
    def __init__(
        self,
        worker_id: str,
        gateway_socket_path: str,
        registrations: List[ActorRegistration],
        heartbeat_ms: int = DEFAULT_HEARTBEAT_MS,
        reconnect_initial_delay_ms: int = DEFAULT_RECONNECT_INITIAL_DELAY_MS,
        reconnect_max_delay_ms: int = DEFAULT_RECONNECT_MAX_DELAY_MS,
        reconnect_max_attempts: int = 0,
    ) -> None:
        self.worker_id = worker_id
        self.language = "python"
        self.gateway_socket_path = gateway_socket_path
        self.registrations = registrations
        self.heartbeat_ms = heartbeat_ms
        self.reconnect_initial_delay_ms = reconnect_initial_delay_ms
        self.reconnect_max_delay_ms = reconnect_max_delay_ms
        # Give up after this many consecutive failed attempts; 0 retries
        # forever. A session that fails to register, or registers but ends
        # within STABLE_SESSION_MS, counts as a failed attempt; a longer one
        # resets the count.
        self.reconnect_max_attempts = reconnect_max_attempts

        self._handlers: Dict[str, ActorHandler] = {}
        # Set by stop(); also what the reconnect backoff sleeps on, so stop()
        # interrupts it.
        self._stopped = threading.Event()
        self._lock = threading.Lock()
        self._session: Optional[_Session] = None

    def run(self) -> None:
        """Registers every actor and serves invocations until `stop()` is
        called. If the gateway isn't up yet, or a session ends (gateway
        restart, dropped connection), reconnects with backoff and
        re-registers (#392). Raises only on what reconnecting can't fix: an
        empty registry, an explicit registration rejection, a fatal gRPC code
        (UNAUTHENTICATED, PERMISSION_DENIED, UNIMPLEMENTED, INVALID_ARGUMENT),
        or `reconnect_max_attempts` consecutive failed attempts."""
        if not self.registrations:
            raise ValueError("no actors to register, refusing to start worker")

        registered_actors = []
        for reg in self.registrations:
            key = actor_key(
                reg["parent_fsm_name"],
                reg["parent_fsm_version"],
                reg["async_operation_type"],
                reg["async_operation_name"],
                reg["async_operation_version"],
                reg["async_operation_language"],
            )
            self._handlers[key] = reg["handler"]
            registered_actors.append(
                pb.RegisteredActor(
                    parent_fsm_name=reg["parent_fsm_name"],
                    parent_fsm_version=reg["parent_fsm_version"],
                    async_operation_type=reg["async_operation_type"],
                    async_operation_name=reg["async_operation_name"],
                    async_operation_version=reg["async_operation_version"],
                    async_operation_language=reg["async_operation_language"],
                )
            )

        failures = 0
        while not self._stopped.is_set():
            session = _Session()
            last_error: Optional[BaseException] = None
            started = time.monotonic()
            try:
                self._run_session(session, registered_actors)
            except Exception as exc:  # noqa: BLE001 — retried below unless fatal
                if _is_fatal(exc):
                    raise
                last_error = exc
            if self._stopped.is_set():
                break

            stable = session.registered and (
                (time.monotonic() - started) * 1000 >= STABLE_SESSION_MS
            )
            failures = 0 if stable else failures + 1
            if self.reconnect_max_attempts > 0 and failures >= self.reconnect_max_attempts:
                raise ConnectionError(
                    f"giving up after {failures} consecutive failed attempt(s) "
                    f"to connect to the gateway: {_describe(last_error)}"
                ) from last_error

            delay_ms = reconnect_delay_ms(
                max(failures, 1), self.reconnect_initial_delay_ms, self.reconnect_max_delay_ms
            )
            if session.registered:
                logger.warning(
                    "Gateway session ended (%s); reconnecting in %dms",
                    _describe(last_error),
                    delay_ms,
                )
            else:
                logger.warning(
                    "Could not connect to the gateway (%s); retrying in %dms",
                    _describe(last_error),
                    delay_ms,
                )
            self._stopped.wait(delay_ms / 1000)

    def stop(self) -> None:
        if self._stopped.is_set():
            return
        self._stopped.set()
        with self._lock:
            session = self._session
        if session is not None:
            session.outbox.put(
                pb.SessionRequest(unregister=pb.Unregister(worker_id=self.worker_id))
            )
            session.outbox.put(None)

    def _run_session(
        self,
        session: _Session,
        registered_actors: List[pb.RegisteredActor],
    ) -> None:
        """One connect -> register -> serve cycle. Sets `session.registered`
        once the gateway acks; run() resets the backoff only if a registered
        session also lasted STABLE_SESSION_MS."""
        # grpc-core sends the socket path itself as the HTTP/2 `:authority`
        # for a bare `unix://` target, which a plain (non-grpc-core) HTTP/2
        # server -- the gateway's connect-node adapter -- can't parse as a
        # host. `grpc.default_authority` overrides it with an ordinary
        # hostname, the standard fix for local/UDS channels against such
        # servers.
        channel = grpc.insecure_channel(
            f"unix://{self.gateway_socket_path}",
            options=[("grpc.default_authority", "localhost")],
        )
        with self._lock:
            self._session = session
        session.outbox.put(
            pb.SessionRequest(
                register=pb.Register(
                    worker_id=self.worker_id,
                    language=self.language,
                    protocol_version="1.0",
                    actors=registered_actors,
                )
            )
        )
        try:
            stub = pb_grpc.SidecarGatewayServiceStub(channel)
            response_iter = iter(stub.Session(_request_iterator(session.outbox)))

            try:
                first = next(response_iter)
            except StopIteration:
                raise ProtocolError("expected register_ack but got EOF") from None
            if first.WhichOneof("payload") != "register_ack":
                raise ProtocolError(
                    f"expected register_ack but got {first.WhichOneof('payload')}"
                )
            if not first.register_ack.accepted:
                raise RegistrationRejectedError()
            session.registered = True

            logger.info(
                "Worker %s registered %d actor(s) with the gateway",
                self.worker_id,
                len(registered_actors),
            )

            threading.Thread(
                target=self._heartbeat_loop, args=(session,), daemon=True
            ).start()

            self._serve_loop(session, response_iter)
        finally:
            # Ends the request stream on every exit path (including a rejected
            # registration or a dropped connection) before the channel goes
            # away.
            session.done.set()
            session.outbox.put(
                pb.SessionRequest(unregister=pb.Unregister(worker_id=self.worker_id))
            )
            session.outbox.put(None)
            with self._lock:
                if self._session is session:
                    self._session = None
            channel.close()

    def _heartbeat_loop(self, session: _Session) -> None:
        while not session.done.wait(self.heartbeat_ms / 1000):
            session.outbox.put(
                pb.SessionRequest(heartbeat=pb.Heartbeat(worker_id=self.worker_id))
            )

    def _serve_loop(
        self, session: _Session, response_iter: Iterator[pb.SessionResponse]
    ) -> None:
        for response in response_iter:
            if self._stopped.is_set():
                break
            case = response.WhichOneof("payload")
            if case == "cancel":
                continue
            if case != "invoke":
                continue
            self._handle_invoke(session, response.invoke)

    def _handle_invoke(self, session: _Session, body: "pb.Invoke") -> None:
        outbox = session.outbox
        key = actor_key(
            body.parent_fsm_name,
            body.parent_fsm_version,
            body.async_operation_type,
            body.async_operation_name,
            body.async_operation_version,
            body.async_operation_language,
        )
        handler = self._handlers.get(key)

        if handler is None:
            _send_error(outbox, body.invoke_id, "NOT_FOUND", f"actor not found: {key}")
            return

        started = time.perf_counter()
        try:
            input_value = _parse_input_json(body.input_json)
            if asyncio.iscoroutinefunction(handler):
                output = asyncio.run(handler(input_value))
            else:
                output = handler(input_value)
            duration_ms = max(0, round((time.perf_counter() - started) * 1000))
            if _warn_if_session_gone(session, body.invoke_id, key):
                return
            outbox.put(
                pb.SessionRequest(
                    invoke_result=pb.InvokeResult(
                        invoke_id=body.invoke_id,
                        output_json=json.dumps(output),
                        duration_ms=duration_ms,
                    )
                )
            )
        except Exception as exc:  # noqa: BLE001 — reported to the gateway, not raised
            logger.debug("Actor %s failed: %s", key, exc, exc_info=True)
            if _warn_if_session_gone(session, body.invoke_id, key):
                return
            _send_error(outbox, body.invoke_id, "INTERNAL", str(exc))


def _request_iterator(
    outbox: "queue.Queue[Optional[pb.SessionRequest]]",
) -> Iterator[pb.SessionRequest]:
    while True:
        item = outbox.get()
        if item is None:
            return
        yield item


def _send_error(
    outbox: "queue.Queue[Optional[pb.SessionRequest]]",
    invoke_id: str,
    code: str,
    message: str,
) -> None:
    outbox.put(
        pb.SessionRequest(
            invoke_error=pb.InvokeError(
                invoke_id=invoke_id,
                error=pb.InvokeErrorDetail(code=code, message=message, retriable=False),
            )
        )
    )


def _warn_if_session_gone(session: _Session, invoke_id: str, key: str) -> bool:
    """An invoke outlived the session it arrived on: its result can't go out
    on a later session (the gateway matches results to the connection it sent
    the invoke on, and has already failed it as WORKER_DISCONNECTED). Log
    instead of dropping it silently."""
    if not session.done.is_set():
        return False
    logger.warning(
        "Dropping result of invoke %s for %s: its gateway session ended",
        invoke_id,
        key,
    )
    return True


def _describe(error: Optional[BaseException]) -> str:
    if error is None:
        return "stream closed"
    if isinstance(error, grpc.RpcError):
        return f"{error.code().name}: {error.details()}"  # type: ignore[attr-defined]
    return str(error)
