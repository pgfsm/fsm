"""SPEC-007 worker side, over real TCP sockets: TLS + bearer token (and token
rotation), mutual TLS, plaintext test mode, concurrency (worker-wide and per
actor, with precedence), graceful drain, and reconnecting after the server's
max connection age.

The gateway here is a grpcio server built from the same stubs (TLS/mTLS via
grpc.ssl_server_credentials, max age via grpc.max_connection_age_ms), so the
tests need no Deno gateway. It checks the bearer token the way the real one
does: missing or wrong -> UNAUTHENTICATED before the Register is read.
"""

from __future__ import annotations

import contextlib
import json
import os
import queue
import threading
import time
from concurrent import futures
from typing import Callable, Iterator, List, Optional

import grpc
import pytest
from conftest import TlsFiles
from pgfsm.sidecargateway.v1 import sidecar_gateway_pb2 as pb
from pgfsm.sidecargateway.v1 import sidecar_gateway_pb2_grpc as pb_grpc

from pgfsm.async_worker_sdk import (
    ActorWorker,
    GatewayAddress,
    effective_max_concurrency,
    parse_gateway_address,
)

IDENTITY = {
    "parent_fsm_name": "creditCheck",
    "parent_fsm_version": "v01",
    "async_operation_type": "internalAsyncOperation",
    "async_operation_version": "v01",
    "async_operation_language": "python",
}

DOUBLE = {**IDENTITY, "async_operation_name": "double", "handler": lambda i: {"doubled": i["n"] * 2}}


def _read(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def wait_for(condition: Callable[[], bool], timeout: float = 5) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            raise TimeoutError("timed out waiting")
        time.sleep(0.02)


class TcpGateway(pb_grpc.SidecarGatewayServiceServicer):
    """Plays the gateway's side of each Session: checks the token, acks the
    Register, then sends whatever `send()` queues to the latest session and
    records everything the worker sends in `from_worker`."""

    def __init__(self, token: Optional[str] = None) -> None:
        self.token = token
        self.registers: List[pb.Register] = []
        self.authorizations: List[Optional[str]] = []
        self.from_worker: "queue.Queue[pb.SessionRequest]" = queue.Queue()
        self._current: "Optional[queue.Queue[Optional[pb.SessionResponse]]]" = None
        self._lock = threading.Lock()

    def Session(self, request_iterator, context) -> Iterator[pb.SessionResponse]:
        authorization = dict(context.invocation_metadata()).get("authorization")
        self.authorizations.append(authorization)
        if self.token is not None and authorization != f"Bearer {self.token}":
            context.abort(grpc.StatusCode.UNAUTHENTICATED, "missing or invalid bearer token")
        first = next(request_iterator)
        out: "queue.Queue[Optional[pb.SessionResponse]]" = queue.Queue()

        def reader() -> None:
            try:
                for req in request_iterator:
                    self.from_worker.put(req)
            except grpc.RpcError:
                pass
            finally:
                out.put(None)

        threading.Thread(target=reader, daemon=True).start()
        with self._lock:
            self._current = out
            self.registers.append(first.register)
        yield pb.SessionResponse(register_ack=pb.RegisterAck(accepted=True))
        while True:
            item = out.get()
            if item is None:
                return
            yield item

    def invoke(self, invoke_id: str, name: str, n: int) -> None:
        with self._lock:
            assert self._current is not None
            self._current.put(
                pb.SessionResponse(
                    invoke=pb.Invoke(
                        invoke_id=invoke_id,
                        input_json=json.dumps({"n": n}),
                        async_operation_name=name,
                        **IDENTITY,
                    )
                )
            )

    def next_of(self, payload: str, timeout: float = 5) -> pb.SessionRequest:
        while True:
            req = self.from_worker.get(timeout=timeout)
            if req.WhichOneof("payload") == payload:
                return req


@contextlib.contextmanager
def serve(
    gateway: TcpGateway,
    tls: Optional[TlsFiles] = None,
    mtls: bool = False,
    max_connection_age_ms: int = 0,
) -> Iterator[str]:
    """Starts `gateway` on 127.0.0.1 (TLS unless `tls` is None) and yields
    the worker's gateway address."""
    options = []
    if max_connection_age_ms:
        options = [
            ("grpc.max_connection_age_ms", max_connection_age_ms),
            ("grpc.max_connection_age_grace_ms", 200),
        ]
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=8), options=options)
    pb_grpc.add_SidecarGatewayServiceServicer_to_server(gateway, server)
    if tls is None:
        port = server.add_insecure_port("127.0.0.1:0")
        url = f"http://127.0.0.1:{port}"
    else:
        credentials = grpc.ssl_server_credentials(
            [(_read(tls.key_file), _read(tls.cert_file))],
            root_certificates=_read(tls.ca_file) if mtls else None,
            require_client_auth=mtls,
        )
        port = server.add_secure_port("127.0.0.1:0", credentials)
        url = f"https://127.0.0.1:{port}"
    server.start()
    try:
        yield url
    finally:
        server.stop(None)


def _start(worker: ActorWorker) -> "tuple[threading.Thread, List[BaseException]]":
    errors: List[BaseException] = []

    def target() -> None:
        try:
            worker.run()
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    return thread, errors


@contextlib.contextmanager
def running(registrations, **options) -> Iterator[ActorWorker]:
    """Runs a worker until the block ends, then stops it."""
    worker = ActorWorker(
        worker_id=f"w-{os.urandom(4).hex()}",
        registrations=registrations,
        heartbeat_ms=50,
        reconnect_initial_delay_ms=20,
        reconnect_max_delay_ms=100,
        **options,
    )
    thread, errors = _start(worker)
    try:
        yield worker
    finally:
        worker.stop()
        thread.join(10)
        assert not thread.is_alive()
    assert errors == []


class Gated:
    """A handler that blocks until released, recording how many run at once."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._gates: List[threading.Event] = []
        self.running = 0
        self.peak = 0
        self.started = 0

    def handler(self, input_value):
        gate = threading.Event()
        with self._lock:
            self.started += 1
            self.running += 1
            self.peak = max(self.peak, self.running)
            self._gates.append(gate)
        gate.wait(10)
        with self._lock:
            self.running -= 1
        return {"done": input_value["n"]}

    def release_one(self) -> None:
        with self._lock:
            self._gates.pop(0).set()

    def release_all(self) -> None:
        with self._lock:
            for gate in self._gates:
                gate.set()
            self._gates.clear()


def test_tls_and_bearer_token_register_and_serve(tls: TlsFiles, tmp_path) -> None:
    token_file = tmp_path / "token"
    token_file.write_text("s3cret\n")
    gateway = TcpGateway(token="s3cret")
    with serve(gateway, tls) as url:
        with running([DOUBLE], gateway_address=url, ca_file=tls.ca_file, token_file=str(token_file)):
            wait_for(lambda: len(gateway.registers) == 1)
            gateway.invoke("inv-1", "double", 21)
            result = gateway.next_of("invoke_result").invoke_result
            assert json.loads(result.output_json) == {"doubled": 42}


def test_wrong_token_fails_fast_with_unauthenticated(tls: TlsFiles, tmp_path) -> None:
    bad = tmp_path / "bad-token"
    bad.write_text("nope")
    gateway = TcpGateway(token="s3cret")
    with serve(gateway, tls) as url:
        worker = ActorWorker(
            worker_id="bad",
            registrations=[DOUBLE],
            gateway_address=url,
            ca_file=tls.ca_file,
            token_file=str(bad),
        )
        with pytest.raises(grpc.RpcError) as info:
            worker.run()
        assert info.value.code() == grpc.StatusCode.UNAUTHENTICATED
        assert len(gateway.authorizations) == 1


def test_token_file_is_re_read_on_every_reconnect(tls: TlsFiles, tmp_path) -> None:
    token_file = tmp_path / "token"
    token_file.write_text("first")
    gateway = TcpGateway()
    with serve(gateway, tls, max_connection_age_ms=300) as url:
        with running([DOUBLE], gateway_address=url, ca_file=tls.ca_file, token_file=str(token_file)):
            wait_for(lambda: len(gateway.registers) == 1)
            token_file.write_text("second")
            wait_for(lambda: len(gateway.registers) >= 2)
    assert gateway.authorizations[0] == "Bearer first"
    assert gateway.authorizations[-1] == "Bearer second"


def test_mutual_tls_with_and_without_a_client_certificate(tls: TlsFiles) -> None:
    gateway = TcpGateway()
    with serve(gateway, tls, mtls=True) as url:
        with running(
            [DOUBLE],
            gateway_address=url,
            ca_file=tls.ca_file,
            cert_file=tls.client_cert_file,
            key_file=tls.client_key_file,
        ):
            wait_for(lambda: len(gateway.registers) == 1)
            gateway.invoke("inv-1", "double", 2)
            result = gateway.next_of("invoke_result").invoke_result
            assert json.loads(result.output_json) == {"doubled": 4}

        no_cert = ActorWorker(
            worker_id="no-cert",
            registrations=[DOUBLE],
            gateway_address=url,
            ca_file=tls.ca_file,
            reconnect_max_attempts=2,
            reconnect_initial_delay_ms=10,
            reconnect_max_delay_ms=20,
        )
        with pytest.raises(ConnectionError, match="giving up"):
            no_cert.run()
        assert len(gateway.registers) == 1


def test_an_untrusted_server_certificate_is_refused(tls: TlsFiles) -> None:
    # No --gateway-ca-file: the test CA isn't in the system roots.
    with serve(TcpGateway(), tls) as url:
        worker = ActorWorker(
            worker_id="untrusting",
            registrations=[DOUBLE],
            gateway_address=url,
            reconnect_max_attempts=2,
            reconnect_initial_delay_ms=10,
            reconnect_max_delay_ms=20,
        )
        with pytest.raises(ConnectionError, match="giving up"):
            worker.run()


def test_plaintext_http_address() -> None:
    gateway = TcpGateway()
    with serve(gateway) as url:
        with running([DOUBLE], gateway_address=url):
            wait_for(lambda: len(gateway.registers) == 1)
            gateway.invoke("inv-1", "double", 5)
            result = gateway.next_of("invoke_result").invoke_result
            assert json.loads(result.output_json) == {"doubled": 10}


def test_invokes_run_concurrently_up_to_max_concurrency_and_never_beyond() -> None:
    gateway = TcpGateway()
    gated = Gated()
    slow = {**IDENTITY, "async_operation_name": "slow", "handler": gated.handler}
    with serve(gateway) as url:
        with running([slow], gateway_address=url, max_concurrency=2):
            wait_for(lambda: len(gateway.registers) == 1)
            assert gateway.registers[0].actors[0].max_concurrency == 2

            # Three invokes: two run at once, the third waits for a slot.
            for n in (1, 2, 3):
                gateway.invoke(f"inv-{n}", "slow", n)
            wait_for(lambda: gated.running == 2)
            time.sleep(0.2)
            assert (gated.running, gated.started) == (2, 2)

            # Finishing one frees its slot: only then does the third start.
            gated.release_one()
            wait_for(lambda: gated.started == 3)
            assert gated.running == 2
            gated.release_all()
            ids = {gateway.next_of("invoke_result").invoke_result.invoke_id for _ in range(3)}
            assert ids == {"inv-1", "inv-2", "inv-3"}
            assert gated.peak == 2


def test_an_actors_own_max_concurrency_overrides_the_workers() -> None:
    gateway = TcpGateway()
    gated = Gated()
    capped = {
        **IDENTITY,
        "async_operation_name": "capped",
        "max_concurrency": 1,
        "handler": gated.handler,
    }
    with serve(gateway) as url:
        with running([capped, DOUBLE], gateway_address=url, max_concurrency=5):
            wait_for(lambda: len(gateway.registers) == 1)
            declared = {
                a.async_operation_name: a.max_concurrency for a in gateway.registers[0].actors
            }
            assert declared == {"capped": 1, "double": 5}

            # The capped actor runs one at a time even with free worker slots.
            gateway.invoke("inv-1", "capped", 1)
            gateway.invoke("inv-2", "capped", 2)
            wait_for(lambda: gated.running == 1)
            time.sleep(0.2)
            assert (gated.running, gated.started) == (1, 1)
            gated.release_one()
            wait_for(lambda: gated.started == 2)
            gated.release_all()
            gateway.next_of("invoke_result")
            gateway.next_of("invoke_result")
            assert gated.peak == 1


def test_stop_drains_refusing_new_invokes_as_retriable() -> None:
    gateway = TcpGateway()
    gated = Gated()
    slow = {**IDENTITY, "async_operation_name": "slow", "handler": gated.handler}
    with serve(gateway) as url:
        worker = ActorWorker(
            worker_id="drainer",
            registrations=[slow],
            gateway_address=url,
            max_concurrency=2,
            shutdown_grace_ms=5000,
            heartbeat_ms=50,
        )
        thread, errors = _start(worker)
        wait_for(lambda: len(gateway.registers) == 1)
        gateway.invoke("inv-1", "slow", 1)
        wait_for(lambda: gated.running == 1)

        worker.stop()  # returns at once; run() returns after the drain
        # Arrives while draining: refused as retriable, not run.
        gateway.invoke("inv-2", "slow", 2)
        err = gateway.next_of("invoke_error").invoke_error
        assert (err.invoke_id, err.error.code, err.error.retriable) == (
            "inv-2",
            "WORKER_DRAINING",
            True,
        )
        assert gated.started == 1
        assert thread.is_alive()

        # The in-flight invoke still completes and its result goes out.
        gated.release_all()
        result = gateway.next_of("invoke_result").invoke_result
        assert result.invoke_id == "inv-1"
        assert gateway.next_of("unregister").unregister.worker_id == "drainer"
        thread.join(5)
        assert not thread.is_alive()
        assert errors == []


def test_drain_gives_up_after_shutdown_grace_ms() -> None:
    gateway = TcpGateway()
    gated = Gated()
    slow = {**IDENTITY, "async_operation_name": "slow", "handler": gated.handler}
    with serve(gateway) as url:
        worker = ActorWorker(
            worker_id="impatient",
            registrations=[slow],
            gateway_address=url,
            shutdown_grace_ms=200,
        )
        thread, errors = _start(worker)
        wait_for(lambda: len(gateway.registers) == 1)
        gateway.invoke("inv-1", "slow", 1)
        wait_for(lambda: gated.running == 1)
        started = time.monotonic()
        worker.stop()
        thread.join(5)
        assert not thread.is_alive()
        assert time.monotonic() - started < 2
        assert errors == []
        gated.release_all()


def test_reconnects_after_the_servers_max_connection_age() -> None:
    gateway = TcpGateway()
    with serve(gateway, max_connection_age_ms=300) as url:
        with running([DOUBLE], gateway_address=url):
            wait_for(lambda: len(gateway.registers) >= 2)
            gateway.invoke("inv-1", "double", 4)
            result = gateway.next_of("invoke_result").invoke_result
            assert json.loads(result.output_json) == {"doubled": 8}


def test_parse_gateway_address() -> None:
    assert parse_gateway_address("unix:/tmp/x.sock") == GatewayAddress(kind="unix", path="/tmp/x.sock")
    assert parse_gateway_address("https://gw:7443") == GatewayAddress(
        kind="tcp", url="https://gw:7443", tls=True
    )
    assert parse_gateway_address("http://127.0.0.1:7443/") == GatewayAddress(
        kind="tcp", url="http://127.0.0.1:7443", tls=False
    )
    assert parse_gateway_address("https://gw:7443").target == "gw:7443"
    assert parse_gateway_address("unix:/tmp/x.sock").target == "unix:/tmp/x.sock"
    for bad in ("unix:", "tcp://gw:1", "https://gw", "gw:7443"):
        with pytest.raises(ValueError, match="gateway address"):
            parse_gateway_address(bad)


def test_effective_max_concurrency_actor_then_worker_then_1() -> None:
    assert effective_max_concurrency(3, 10) == 3
    assert effective_max_concurrency(None, 10) == 10
    assert effective_max_concurrency(None, None) == 1
    assert effective_max_concurrency(0, 0) == 1


def test_needs_an_address() -> None:
    with pytest.raises(ValueError, match="gateway_address or gateway_socket_path"):
        ActorWorker(worker_id="w", registrations=[DOUBLE])
