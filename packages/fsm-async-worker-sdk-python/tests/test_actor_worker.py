"""ActorWorker end to end against an in-process SidecarGatewayService over a
real Unix socket: register, invoke, and a handler error surfacing as INTERNAL.

The fake gateway below is a grpcio server built from the same
pgfsm-proto-codegen stubs; it plays the gateway's side of the Session stream
just far enough to drive the worker.
"""

from __future__ import annotations

import json
import os
import queue
import tempfile
import threading
from concurrent import futures
from typing import Iterator, List

import grpc
import pytest
from pgfsm.sidecargateway.v1 import sidecar_gateway_pb2 as pb
from pgfsm.sidecargateway.v1 import sidecar_gateway_pb2_grpc as pb_grpc

from pgfsm.async_worker_sdk import ActorWorker, ProtocolError, run_actor_worker_cli

ACTOR = {
    "parent_fsm_name": "creditCheck",
    "parent_fsm_version": "v01",
    "async_operation_type": "internalAsyncOperation",
    "async_operation_name": "checkBureau",
    "async_operation_version": "v01",
    "async_operation_language": "python",
}


def _check_bureau(input_value):
    return {"input": input_value, "msg": "checkBureau actor invoked by python"}


def _failing(_input_value):
    raise RuntimeError("boom")


class FakeGateway(pb_grpc.SidecarGatewayServiceServicer):
    """Acks the registration, then sends whatever is queued on `to_worker`
    and records every message the worker sends in `from_worker`."""

    def __init__(self, accept: bool = True) -> None:
        self.accept = accept
        self.to_worker: "queue.Queue[pb.SessionResponse | None]" = queue.Queue()
        self.from_worker: "queue.Queue[pb.SessionRequest]" = queue.Queue()
        self.registered = threading.Event()

    def Session(self, request_iterator, context) -> Iterator[pb.SessionResponse]:
        def reader() -> None:
            try:
                for req in request_iterator:
                    self.from_worker.put(req)
                    if req.WhichOneof("payload") == "register":
                        self.registered.set()
            except grpc.RpcError:
                pass  # the worker closed its channel mid-stream
            finally:
                self.to_worker.put(None)

        threading.Thread(target=reader, daemon=True).start()
        if not self.registered.wait(5):
            return
        yield pb.SessionResponse(register_ack=pb.RegisterAck(accepted=self.accept))
        if not self.accept:
            return
        while True:
            item = self.to_worker.get()
            if item is None:
                return
            yield item

    def next_of(self, payload: str, timeout: float = 5) -> pb.SessionRequest:
        while True:
            req = self.from_worker.get(timeout=timeout)
            if req.WhichOneof("payload") == payload:
                return req


@pytest.fixture
def socket_path() -> Iterator[str]:
    # AF_UNIX paths are capped at ~104 bytes on macOS, so keep it short.
    with tempfile.TemporaryDirectory(prefix="pgfsm-") as d:
        yield os.path.join(d, "gw.sock")


def _serve(gateway: FakeGateway, socket_path: str) -> grpc.Server:
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    pb_grpc.add_SidecarGatewayServiceServicer_to_server(gateway, server)
    server.add_insecure_port(f"unix://{socket_path}")
    server.start()
    return server


def _invoke(invoke_id: str, name: str, input_value) -> pb.SessionResponse:
    fields = {**ACTOR, "async_operation_name": name}
    return pb.SessionResponse(
        invoke=pb.Invoke(invoke_id=invoke_id, input_json=json.dumps(input_value), **fields)
    )


def _start(worker: ActorWorker) -> tuple[threading.Thread, List[BaseException]]:
    errors: List[BaseException] = []

    def target() -> None:
        try:
            worker.run()
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    t = threading.Thread(target=target, daemon=True)
    t.start()
    return t, errors


def test_register_invoke_and_handler_error(socket_path: str) -> None:
    gateway = FakeGateway()
    server = _serve(gateway, socket_path)
    worker = ActorWorker(
        worker_id="python-test",
        gateway_socket_path=socket_path,
        registrations=[
            {**ACTOR, "handler": _check_bureau},
            {**ACTOR, "async_operation_name": "failing", "handler": _failing},
        ],
        heartbeat_ms=60_000,
    )
    thread, errors = _start(worker)
    try:
        register = gateway.next_of("register").register
        assert register.worker_id == "python-test"
        assert register.language == "python"
        assert [a.async_operation_name for a in register.actors] == ["checkBureau", "failing"]

        gateway.to_worker.put(_invoke("inv-1", "checkBureau", {"ssn": "123"}))
        result = gateway.next_of("invoke_result").invoke_result
        assert result.invoke_id == "inv-1"
        assert json.loads(result.output_json) == {
            "input": {"ssn": "123"},
            "msg": "checkBureau actor invoked by python",
        }

        gateway.to_worker.put(_invoke("inv-2", "failing", None))
        err = gateway.next_of("invoke_error").invoke_error
        assert (err.invoke_id, err.error.code, err.error.message) == ("inv-2", "INTERNAL", "boom")

        gateway.to_worker.put(_invoke("inv-3", "missing", None))
        err = gateway.next_of("invoke_error").invoke_error
        assert (err.invoke_id, err.error.code) == ("inv-3", "NOT_FOUND")

        worker.stop()
        assert gateway.next_of("unregister").unregister.worker_id == "python-test"
        thread.join(5)
        assert not thread.is_alive()
        assert errors == []
    finally:
        worker.stop()
        server.stop(None)


def test_rejected_registration_raises(socket_path: str) -> None:
    server = _serve(FakeGateway(accept=False), socket_path)
    try:
        worker = ActorWorker(
            worker_id="python-test",
            gateway_socket_path=socket_path,
            registrations=[{**ACTOR, "handler": _check_bureau}],
        )
        with pytest.raises(ProtocolError, match="rejected"):
            worker.run()
    finally:
        server.stop(None)


def test_empty_registry_refuses_to_start() -> None:
    worker = ActorWorker(worker_id="w", gateway_socket_path="/nonexistent.sock", registrations=[])
    with pytest.raises(ValueError):
        worker.run()


def test_cli_start_serves_until_stopped(socket_path: str) -> None:
    gateway = FakeGateway()
    server = _serve(gateway, socket_path)
    exit_codes: List[int] = []
    thread = threading.Thread(
        target=lambda: exit_codes.append(
            run_actor_worker_cli(
                [{**ACTOR, "handler": _check_bureau}],
                ["start", "--gateway-socket", socket_path, "--worker-id", "python-cli"],
            )
        ),
        daemon=True,
    )
    thread.start()
    try:
        assert gateway.next_of("register").register.worker_id == "python-cli"
        # The gateway ending the stream ends the worker cleanly.
        gateway.to_worker.put(None)
        thread.join(5)
        assert exit_codes == [0]
    finally:
        server.stop(None)
