"""SPEC-012 (e), #541: every handler gets a CancellationToken, and the worker
honours Cancel. Against the fake gateway from test_actor_worker.py: a Cancel
cancels the invoke's token with its reason, a raise after it is reported as
CANCELLED and a return as the result (sync and async handlers), the session
ending cancels every running invoke with SHUTDOWN, an unknown invoke's Cancel
is ignored, one still waiting for its slot never runs, and the worker sends
protocol 2.0 and the CLI exits 1 on a rejected registration.
"""

from __future__ import annotations

import threading
import time
from typing import List

import pytest
from pgfsm.sidecargateway.v1 import sidecar_gateway_pb2 as pb
from test_actor_worker import (  # type: ignore[import-not-found]
    ACTOR,
    FakeGateway,
    _check_bureau,
    _invoke,
    _serve,
    _start,
    socket_path,  # noqa: F401 -- the fixture, shared
)

from pgfsm.async_worker_sdk import (
    SIDECAR_PROTOCOL_VERSION,
    ActorWorker,
    CancellationToken,
    InvokeCancelledError,
    cancel_reason_name,
    run_actor_worker_cli,
)


class Seen:
    """What the cancel handlers saw: how many started, and each reason."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.started = 0
        self.reasons: List[str] = []

    def wait_for(self, condition, timeout: float = 5) -> None:
        deadline = time.monotonic() + timeout
        while not condition():
            assert time.monotonic() < deadline, "timed out waiting on the handlers"
            time.sleep(0.005)

    def handlers(self):
        def wait(token: CancellationToken) -> None:
            with self.lock:
                self.started += 1
            assert token.wait(10)
            with self.lock:
                self.reasons.append(token.reason)

        def wait_then_raise(_input, token: CancellationToken):
            wait(token)
            token.raise_if_cancelled()

        def wait_then_return(_input, token: CancellationToken):
            wait(token)
            return {"finishedAnyway": True}

        async def async_wait_then_raise(_input, token: CancellationToken):
            wait(token)
            token.raise_if_cancelled()

        return [
            {**ACTOR, "async_operation_name": "waitThenRaise", "handler": wait_then_raise},
            {**ACTOR, "async_operation_name": "waitThenReturn", "handler": wait_then_return},
            {
                **ACTOR,
                "async_operation_name": "asyncWaitThenRaise",
                "handler": async_wait_then_raise,
            },
        ]


def _cancel(invoke_id: str, reason: int) -> pb.SessionResponse:
    return pb.SessionResponse(cancel=pb.Cancel(invoke_id=invoke_id, reason=reason))


def _next_reply(gateway: FakeGateway) -> tuple[str, str]:
    while True:
        req = gateway.from_worker.get(timeout=5)
        kind = req.WhichOneof("payload")
        if kind == "invoke_result":
            return req.invoke_result.invoke_id, "RESULT"
        if kind == "invoke_error":
            return req.invoke_error.invoke_id, req.invoke_error.error.code


@pytest.fixture
def running(socket_path: str):
    """A fake gateway and a started worker serving Seen's handlers."""
    gateway = FakeGateway()
    server = _serve(gateway, socket_path)
    seen = Seen()
    workers: List[ActorWorker] = []

    def start(max_concurrency: int = 3) -> ActorWorker:
        worker = ActorWorker(
            worker_id="python-cancel",
            gateway_socket_path=socket_path,
            registrations=seen.handlers(),
            heartbeat_ms=60_000,
            max_concurrency=max_concurrency,
            shutdown_grace_ms=100,
        )
        workers.append(worker)
        _start(worker)
        gateway.next_of("register")
        return worker

    yield gateway, seen, start
    for worker in workers:
        worker.stop()
    server.stop(None)


def test_sends_protocol_2_and_reason_names_match_the_proto(socket_path: str) -> None:
    assert SIDECAR_PROTOCOL_VERSION == "2.0"
    assert [cancel_reason_name(n) for n in (0, 1, 2, 3, 99)] == [
        "UNSPECIFIED",
        "STATE_EXITED",
        "TIMEOUT",
        "SHUTDOWN",
        "UNSPECIFIED",
    ]
    assert pb.CancelReason.Value("CANCEL_REASON_STATE_EXITED") == 1
    gateway = FakeGateway()
    server = _serve(gateway, socket_path)
    worker = ActorWorker(
        worker_id="python-proto",
        gateway_socket_path=socket_path,
        registrations=[{**ACTOR, "handler": _check_bureau}],
    )
    try:
        _start(worker)
        assert gateway.next_of("register").register.protocol_version == "2.0"
    finally:
        worker.stop()
        server.stop(None)


def test_cancel_cancels_the_token_and_a_raise_after_it_is_cancelled(running) -> None:
    gateway, seen, start = running
    start()
    gateway.to_worker.put(_invoke("raise", "waitThenRaise", None))
    seen.wait_for(lambda: seen.started == 1)
    gateway.to_worker.put(_cancel("raise", pb.CANCEL_REASON_STATE_EXITED))
    assert _next_reply(gateway) == ("raise", "CANCELLED")
    assert seen.reasons == ["STATE_EXITED"]

    # A return after the cancel is still the result.
    gateway.to_worker.put(_invoke("ret", "waitThenReturn", None))
    seen.wait_for(lambda: seen.started == 2)
    gateway.to_worker.put(_cancel("ret", pb.CANCEL_REASON_TIMEOUT))
    assert _next_reply(gateway) == ("ret", "RESULT")

    # An async handler gets the token too.
    gateway.to_worker.put(_invoke("async", "asyncWaitThenRaise", None))
    seen.wait_for(lambda: seen.started == 3)
    gateway.to_worker.put(_cancel("async", pb.CANCEL_REASON_STATE_EXITED))
    assert _next_reply(gateway) == ("async", "CANCELLED")
    assert seen.reasons == ["STATE_EXITED", "TIMEOUT", "STATE_EXITED"]


def test_the_session_ending_cancels_running_invokes_with_shutdown(running) -> None:
    gateway, seen, start = running
    start()
    gateway.to_worker.put(_invoke("a", "waitThenRaise", None))
    gateway.to_worker.put(_invoke("b", "waitThenReturn", None))
    seen.wait_for(lambda: seen.started == 2)
    gateway.to_worker.put(None)  # ends the session
    seen.wait_for(lambda: len(seen.reasons) == 2)
    assert seen.reasons == ["SHUTDOWN", "SHUTDOWN"]


def test_an_unknown_cancel_is_ignored_and_a_queued_invoke_never_runs(running) -> None:
    gateway, seen, start = running
    start(max_concurrency=1)
    gateway.to_worker.put(_cancel("unknown", pb.CANCEL_REASON_STATE_EXITED))
    gateway.to_worker.put(_invoke("first", "waitThenReturn", None))
    seen.wait_for(lambda: seen.started == 1)
    gateway.to_worker.put(_invoke("second", "waitThenReturn", None))
    time.sleep(0.05)  # let it reach the slot wait
    gateway.to_worker.put(_cancel("second", pb.CANCEL_REASON_STATE_EXITED))
    assert _next_reply(gateway) == ("second", "CANCELLED")

    gateway.to_worker.put(_cancel("first", pb.CANCEL_REASON_TIMEOUT))
    assert _next_reply(gateway) == ("first", "RESULT")
    assert seen.started == 1


def test_raise_if_cancelled_carries_the_reason() -> None:
    token = CancellationToken()
    assert not token.cancelled and token.reason is None
    token.raise_if_cancelled()
    assert token.wait(0.01) is False
    token._cancel("TIMEOUT")
    token._cancel("SHUTDOWN")  # the first reason wins
    assert token.cancelled and token.reason == "TIMEOUT"
    with pytest.raises(InvokeCancelledError) as raised:
        token.raise_if_cancelled()
    assert raised.value.reason == "TIMEOUT"


def test_the_cli_exits_1_on_a_rejected_registration(socket_path: str) -> None:
    gateway = FakeGateway(accept=False)
    server = _serve(gateway, socket_path)
    try:
        code = run_actor_worker_cli(
            [{**ACTOR, "handler": _check_bureau}],
            ["start", "--gateway-socket", socket_path],
        )
        assert code == 1
        assert gateway.sessions == 1
    finally:
        server.stop(None)
