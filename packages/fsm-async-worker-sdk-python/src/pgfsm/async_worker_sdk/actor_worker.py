"""ActorWorker: the client end of the Activity Gateway's sidecar leg.

Moved here from fsm-compiler-ts's python/worker-sdk-sdk.eta (#364), which used
to write this whole module into every project as `async-worker/python/sdk.py`.

Connects to the gateway's sidecar, over its Unix socket or over TCP (TLS,
bearer token and/or mutual TLS -- SPEC-007), via the generated
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
async_operation_version/async_operation_language/handler, and optionally
max_concurrency) directly; it stays
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
import re
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterator, List, Optional, Set, Tuple

import grpc
from pgfsm.sidecargateway.v1 import sidecar_gateway_pb2 as pb
from pgfsm.sidecargateway.v1 import sidecar_gateway_pb2_grpc as pb_grpc

logger = logging.getLogger("pgfsm.async_worker_sdk")

ActorHandler = Callable[[Any], Any]
ActorRegistration = Dict[str, Any]

DEFAULT_HEARTBEAT_MS = 5000
DEFAULT_KEEPALIVE_INTERVAL_MS = 30000
DEFAULT_KEEPALIVE_TIMEOUT_MS = 10000
DEFAULT_SHUTDOWN_GRACE_MS = 25000
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


@dataclass(frozen=True)
class GatewayAddress:
    """A parsed gateway address: `kind` "unix" with `path`, or "tcp" with
    `url` (no trailing slash) and whether it's `tls`."""

    kind: str
    path: str = ""
    url: str = ""
    tls: bool = False

    @property
    def target(self) -> str:
        """The grpc channel target."""
        if self.kind == "unix":
            return f"unix:{self.path}"
        return self.url.split("://", 1)[1]


_TCP_ADDRESS = re.compile(r"^(https?)://[^/]+:\d+/?$")


def parse_gateway_address(address: str) -> GatewayAddress:
    """Parses `unix:<path>`, `https://host:port` or `http://host:port`."""
    if address.startswith("unix:") and len(address) > len("unix:"):
        return GatewayAddress(kind="unix", path=address[len("unix:") :])
    match = _TCP_ADDRESS.match(address)
    if match:
        return GatewayAddress(
            kind="tcp", url=address.rstrip("/"), tls=match.group(1) == "https"
        )
    raise ValueError(
        "gateway address must be unix:<path>, https://host:port or "
        f"http://host:port, got: {address}"
    )


def effective_max_concurrency(
    actor_max: Optional[int], worker_max: Optional[int]
) -> int:
    """The limit an actor runs under: its own, else the worker's, else 1."""
    for value in (actor_max, worker_max):
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            return value
    return 1


class _Session:
    """Per-connection state: the outgoing queue grpc drains as the request
    stream, and whether the gateway acked this session's registration."""

    def __init__(self, worker_id: str) -> None:
        self.outbox: "queue.Queue[Optional[pb.SessionRequest]]" = queue.Queue()
        self.registered = False
        self.done = threading.Event()
        self._worker_id = worker_id
        self._lock = threading.Lock()

    def send(self, request: pb.SessionRequest) -> bool:
        """Queues `request`; False once the session is closed."""
        with self._lock:
            if self.done.is_set():
                return False
            self.outbox.put(request)
            return True

    def close(self) -> None:
        """Unregisters and ends the request stream; idempotent."""
        with self._lock:
            if self.done.is_set():
                return
            self.done.set()
            self.outbox.put(
                pb.SessionRequest(unregister=pb.Unregister(worker_id=self._worker_id))
            )
            self.outbox.put(None)


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
    """Connects to the gateway's sidecar, registers `registrations`, and
    serves invoke requests until `stop()` is called. If the gateway isn't up
    yet, or a session ends (gateway restart, dropped connection, max
    connection age), it reconnects with backoff on a new channel and
    re-registers (#392).

    Invokes run concurrently, each on its own thread, up to each actor's limit
    (its own `max_concurrency`, else the worker's, else 1); extra invokes of an
    actor wait for a slot. `stop()` drains: new invokes are refused as
    retriable (`WORKER_DRAINING`, so the gateway delivers them again
    elsewhere) while in-flight ones finish, up to `shutdown_grace_ms`.
    """

    def __init__(
        self,
        worker_id: str,
        gateway_socket_path: Optional[str] = None,
        registrations: Optional[List[ActorRegistration]] = None,
        heartbeat_ms: int = DEFAULT_HEARTBEAT_MS,
        reconnect_initial_delay_ms: int = DEFAULT_RECONNECT_INITIAL_DELAY_MS,
        reconnect_max_delay_ms: int = DEFAULT_RECONNECT_MAX_DELAY_MS,
        reconnect_max_attempts: int = 0,
        *,
        gateway_address: Optional[str] = None,
        ca_file: Optional[str] = None,
        token_file: Optional[str] = None,
        cert_file: Optional[str] = None,
        key_file: Optional[str] = None,
        keepalive_interval_ms: int = DEFAULT_KEEPALIVE_INTERVAL_MS,
        keepalive_timeout_ms: int = DEFAULT_KEEPALIVE_TIMEOUT_MS,
        max_concurrency: Optional[int] = None,
        shutdown_grace_ms: int = DEFAULT_SHUTDOWN_GRACE_MS,
    ) -> None:
        self.worker_id = worker_id
        self.language = "python"
        # `gateway_address` (unix:<path>, https://host:port, or http://host:port
        # for the gateway's --insecure-plaintext test mode) takes precedence;
        # `gateway_socket_path` is shorthand for unix:<path>.
        address = gateway_address or (
            f"unix:{gateway_socket_path}" if gateway_socket_path else None
        )
        if not address:
            raise ValueError("ActorWorker needs gateway_address or gateway_socket_path")
        self.address = parse_gateway_address(address)
        self.gateway_socket_path = gateway_socket_path
        self.registrations = registrations or []
        self.heartbeat_ms = heartbeat_ms
        self.reconnect_initial_delay_ms = reconnect_initial_delay_ms
        self.reconnect_max_delay_ms = reconnect_max_delay_ms
        # Give up after this many consecutive failed attempts; 0 retries
        # forever. A session that fails to register, or registers but ends
        # within STABLE_SESSION_MS, counts as a failed attempt; a longer one
        # resets the count.
        self.reconnect_max_attempts = reconnect_max_attempts
        # PEM CA bundle for the gateway's TLS certificate (default: system
        # roots), the bearer token file, and the mutual TLS client
        # certificate/key. All re-read for every session, so rotated files
        # apply from the next reconnect.
        self.ca_file = ca_file
        self.token_file = token_file
        self.cert_file = cert_file
        self.key_file = key_file
        # HTTP/2 PINGs on TCP channels; one unanswered for keepalive_timeout_ms
        # drops the session so the worker reconnects. 0 disables. Not used for
        # Unix sockets.
        self.keepalive_interval_ms = keepalive_interval_ms
        self.keepalive_timeout_ms = keepalive_timeout_ms
        # Invokes of each actor run at once, for actors without their own
        # max_concurrency (default 1: one at a time, the historical behaviour).
        self.max_concurrency = max_concurrency
        self.shutdown_grace_ms = shutdown_grace_ms

        self._handlers: Dict[str, ActorHandler] = {}
        self._slots: Dict[str, threading.Semaphore] = {}
        # Set by stop(); also what the reconnect backoff sleeps on, so stop()
        # interrupts it.
        self._stopping = threading.Event()
        # Set once the drain is over and the session is closed.
        self._stopped = threading.Event()
        self._lock = threading.Lock()
        self._session: Optional[_Session] = None
        self._in_flight: Set[threading.Thread] = set()

    def run(self) -> None:
        """Registers every actor and serves invocations until `stop()` is
        called, then returns once the drain is over. Raises only on what
        reconnecting can't fix: an empty registry, an explicit registration
        rejection, a fatal gRPC code (UNAUTHENTICATED, PERMISSION_DENIED,
        UNIMPLEMENTED, INVALID_ARGUMENT), or `reconnect_max_attempts`
        consecutive failed attempts."""
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
            max_concurrency = effective_max_concurrency(
                reg.get("max_concurrency"), self.max_concurrency
            )
            self._handlers[key] = reg["handler"]
            self._slots[key] = threading.Semaphore(max_concurrency)
            registered_actors.append(
                pb.RegisteredActor(
                    parent_fsm_name=reg["parent_fsm_name"],
                    parent_fsm_version=reg["parent_fsm_version"],
                    async_operation_type=reg["async_operation_type"],
                    async_operation_name=reg["async_operation_name"],
                    async_operation_version=reg["async_operation_version"],
                    async_operation_language=reg["async_operation_language"],
                    max_concurrency=max_concurrency,
                )
            )

        failures = 0
        while not self._stopping.is_set():
            session = _Session(self.worker_id)
            last_error: Optional[BaseException] = None
            started = time.monotonic()
            try:
                self._run_session(session, registered_actors)
            except Exception as exc:  # noqa: BLE001 — retried below unless fatal
                if _is_fatal(exc):
                    raise
                last_error = exc
            if self._stopping.is_set():
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
            self._stopping.wait(delay_ms / 1000)
        self._stopped.wait()

    def stop(self) -> None:
        """Stops gracefully, without blocking (safe from a signal handler):
        new invokes are refused as retriable while in-flight ones finish (up
        to `shutdown_grace_ms`), then the worker unregisters and closes its
        session. `run()` returns once that's done. Calling it again does
        nothing."""
        with self._lock:
            if self._stopping.is_set():
                return
            self._stopping.set()
        threading.Thread(target=self._drain, name="pgfsm-drain", daemon=True).start()

    def _drain(self) -> None:
        with self._lock:
            in_flight = list(self._in_flight)
        if in_flight:
            logger.info(
                "Draining %d in-flight invoke(s) before stopping (up to %dms)",
                len(in_flight),
                self.shutdown_grace_ms,
            )
            deadline = time.monotonic() + self.shutdown_grace_ms / 1000
            for thread in in_flight:
                thread.join(max(0.0, deadline - time.monotonic()))
        self._stopped.set()
        with self._lock:
            session = self._session
        if session is not None:
            session.close()

    def _open_channel(self) -> Tuple[grpc.Channel, List[Tuple[str, str]]]:
        """A new channel for one session, so a reconnect after the gateway's
        max connection age can reach another replica. TLS material and the
        token are read now, so rotated files apply from the next session."""
        metadata: List[Tuple[str, str]] = []
        if self.token_file:
            token = _read_bytes(self.token_file).decode().strip()
            metadata.append(("authorization", f"Bearer {token}"))

        if self.address.kind == "unix":
            # grpc-core sends the socket path itself as the HTTP/2
            # `:authority` for a `unix:` target, which a plain (non-grpc-core)
            # HTTP/2 server -- the gateway's connect-node adapter -- can't
            # parse as a host. `grpc.default_authority` overrides it with an
            # ordinary hostname, the standard fix for local/UDS channels
            # against such servers.
            channel = grpc.insecure_channel(
                self.address.target, options=[("grpc.default_authority", "localhost")]
            )
            return channel, metadata

        options: List[Tuple[str, Any]] = []
        if self.keepalive_interval_ms > 0:
            options += [
                ("grpc.keepalive_time_ms", self.keepalive_interval_ms),
                ("grpc.keepalive_timeout_ms", self.keepalive_timeout_ms),
                # By default grpc-core stops pinging after two PINGs with no
                # data frame in between; a quiet session must keep pinging.
                ("grpc.http2.max_pings_without_data", 0),
            ]
        if not self.address.tls:
            return grpc.insecure_channel(self.address.target, options=options), metadata

        credentials = grpc.ssl_channel_credentials(
            root_certificates=_read_bytes(self.ca_file) if self.ca_file else None,
            private_key=(
                _read_bytes(self.key_file) if self.cert_file and self.key_file else None
            ),
            certificate_chain=(
                _read_bytes(self.cert_file) if self.cert_file and self.key_file else None
            ),
        )
        channel = grpc.secure_channel(self.address.target, credentials, options=options)
        return channel, metadata

    def _run_session(
        self,
        session: _Session,
        registered_actors: List[pb.RegisteredActor],
    ) -> None:
        """One connect -> register -> serve cycle. Sets `session.registered`
        once the gateway acks; run() resets the backoff only if a registered
        session also lasted STABLE_SESSION_MS."""
        # Published under the lock stop() takes: either stop() came first and
        # no session starts, or the drain finds this one and closes it.
        with self._lock:
            if self._stopping.is_set():
                return
            self._session = session
        try:
            channel, metadata = self._open_channel()
        except BaseException:
            with self._lock:
                self._session = None
            raise
        session.send(
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
            response_iter = iter(
                stub.Session(_request_iterator(session.outbox), metadata=metadata or None)
            )

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
            session.close()
            with self._lock:
                if self._session is session:
                    self._session = None
            channel.close()

    def _heartbeat_loop(self, session: _Session) -> None:
        while not session.done.wait(self.heartbeat_ms / 1000):
            session.send(pb.SessionRequest(heartbeat=pb.Heartbeat(worker_id=self.worker_id)))

    def _serve_loop(
        self, session: _Session, response_iter: Iterator[pb.SessionResponse]
    ) -> None:
        for response in response_iter:
            if self._stopped.is_set():
                break
            if response.WhichOneof("payload") != "invoke":
                continue
            body = response.invoke
            with self._lock:
                draining = self._stopping.is_set()
                if not draining:
                    # Not run inline: invokes run concurrently, each actor
                    # bounded by its own slots (see _handle_invoke). Started
                    # under the lock so _drain never sees an unstarted thread.
                    thread = threading.Thread(
                        target=self._run_invoke, args=(session, body), daemon=True
                    )
                    self._in_flight.add(thread)
                    thread.start()
            if draining:
                # Refused as retriable, so the gateway leaves the message on
                # its queue for another worker (#396).
                _send_error(
                    session,
                    body.invoke_id,
                    "WORKER_DRAINING",
                    "worker is shutting down",
                    retriable=True,
                )

    def _run_invoke(self, session: _Session, body: "pb.Invoke") -> None:
        try:
            self._handle_invoke(session, body)
        finally:
            with self._lock:
                self._in_flight.discard(threading.current_thread())

    def _handle_invoke(self, session: _Session, body: "pb.Invoke") -> None:
        key = actor_key(
            body.parent_fsm_name,
            body.parent_fsm_version,
            body.async_operation_type,
            body.async_operation_name,
            body.async_operation_version,
            body.async_operation_language,
        )
        handler = self._handlers.get(key)
        slots = self._slots.get(key)

        if handler is None or slots is None:
            _send_error(session, body.invoke_id, "NOT_FOUND", f"actor not found: {key}")
            return

        # Never run more of this actor than declared, even if the gateway
        # sends more (after its own invoke timeout, or through a direct
        # Invoke() RPC).
        with slots:
            started = time.perf_counter()
            try:
                input_value = _parse_input_json(body.input_json)
                if asyncio.iscoroutinefunction(handler):
                    output = asyncio.run(handler(input_value))
                else:
                    output = handler(input_value)
                duration_ms = max(0, round((time.perf_counter() - started) * 1000))
                result = pb.SessionRequest(
                    invoke_result=pb.InvokeResult(
                        invoke_id=body.invoke_id,
                        output_json=json.dumps(output),
                        duration_ms=duration_ms,
                    )
                )
            except Exception as exc:  # noqa: BLE001 — reported to the gateway, not raised
                logger.debug("Actor %s failed: %s", key, exc, exc_info=True)
                _send_error(session, body.invoke_id, "INTERNAL", str(exc), key=key)
                return
        if not session.send(result):
            _warn_session_gone(body.invoke_id, key)


def _request_iterator(
    outbox: "queue.Queue[Optional[pb.SessionRequest]]",
) -> Iterator[pb.SessionRequest]:
    while True:
        item = outbox.get()
        if item is None:
            return
        yield item


def _send_error(
    session: _Session,
    invoke_id: str,
    code: str,
    message: str,
    retriable: bool = False,
    key: Optional[str] = None,
) -> None:
    sent = session.send(
        pb.SessionRequest(
            invoke_error=pb.InvokeError(
                invoke_id=invoke_id,
                error=pb.InvokeErrorDetail(code=code, message=message, retriable=retriable),
            )
        )
    )
    if not sent and key is not None:
        _warn_session_gone(invoke_id, key)


def _warn_session_gone(invoke_id: str, key: str) -> None:
    """An invoke outlived the session it arrived on: its result can't go out
    on a later session (the gateway matches results to the connection it sent
    the invoke on, and has already failed it as WORKER_DISCONNECTED). Log
    instead of dropping it silently."""
    logger.warning(
        "Dropping result of invoke %s for %s: its gateway session ended",
        invoke_id,
        key,
    )


def _read_bytes(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def _describe(error: Optional[BaseException]) -> str:
    if error is None:
        return "stream closed"
    if isinstance(error, grpc.RpcError):
        return f"{error.code().name}: {error.details()}"  # type: ignore[attr-defined]
    return str(error)
