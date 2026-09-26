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


class ProtocolError(Exception):
    pass


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
    ) -> None:
        self.worker_id = worker_id
        self.language = "python"
        self.gateway_socket_path = gateway_socket_path
        self.registrations = registrations
        self.heartbeat_ms = heartbeat_ms

        self._handlers: Dict[str, ActorHandler] = {}
        self._stopped = False
        self._outbox: "queue.Queue[Optional[pb.SessionRequest]]" = queue.Queue()
        self._channel: Optional[grpc.Channel] = None

    def run(self) -> None:
        """Registers every actor and serves invocations until `stop()` is
        called or the gateway ends the stream. Closes the gRPC channel before
        returning."""
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

        # grpc-core sends the socket path itself as the HTTP/2 `:authority`
        # for a bare `unix://` target, which a plain (non-grpc-core) HTTP/2
        # server -- the gateway's connect-node adapter -- can't parse as a
        # host. `grpc.default_authority` overrides it with an ordinary
        # hostname, the standard fix for local/UDS channels against such
        # servers.
        self._channel = grpc.insecure_channel(
            f"unix://{self.gateway_socket_path}",
            options=[("grpc.default_authority", "localhost")],
        )
        try:
            self._run_session(pb_grpc.SidecarGatewayServiceStub(self._channel), registered_actors)
        finally:
            # Ends the request stream on every exit path (including a rejected
            # registration) before the channel goes away.
            self.stop()
            self._channel.close()
            self._channel = None

    def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        self._outbox.put(
            pb.SessionRequest(unregister=pb.Unregister(worker_id=self.worker_id))
        )
        self._outbox.put(None)

    def _run_session(
        self,
        stub: pb_grpc.SidecarGatewayServiceStub,
        registered_actors: List[pb.RegisteredActor],
    ) -> None:
        self._outbox.put(
            pb.SessionRequest(
                register=pb.Register(
                    worker_id=self.worker_id,
                    language=self.language,
                    protocol_version="1.0",
                    actors=registered_actors,
                )
            )
        )

        response_iter = iter(stub.Session(self._request_iterator()))

        try:
            first = next(response_iter)
        except StopIteration:
            raise ProtocolError("expected register_ack but got EOF") from None
        if first.WhichOneof("payload") != "register_ack":
            raise ProtocolError(
                f"expected register_ack but got {first.WhichOneof('payload')}"
            )
        if not first.register_ack.accepted:
            raise ProtocolError("gateway rejected registration")

        logger.info(
            "Worker %s registered %d actor(s) with the gateway",
            self.worker_id,
            len(registered_actors),
        )

        heartbeat_thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
        heartbeat_thread.start()

        self._serve_loop(response_iter)

    def _request_iterator(self) -> Iterator[pb.SessionRequest]:
        while True:
            item = self._outbox.get()
            if item is None:
                return
            yield item

    def _heartbeat_loop(self) -> None:
        while not self._stopped:
            time.sleep(self.heartbeat_ms / 1000)
            if self._stopped:
                break
            self._outbox.put(
                pb.SessionRequest(heartbeat=pb.Heartbeat(worker_id=self.worker_id))
            )

    def _serve_loop(self, response_iter: Iterator[pb.SessionResponse]) -> None:
        for response in response_iter:
            if self._stopped:
                break
            case = response.WhichOneof("payload")
            if case == "cancel":
                continue
            if case != "invoke":
                continue
            self._handle_invoke(response.invoke)

    def _handle_invoke(self, body: "pb.Invoke") -> None:
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
            self._send_error(body.invoke_id, "NOT_FOUND", f"actor not found: {key}")
            return

        started = time.perf_counter()
        try:
            input_value = _parse_input_json(body.input_json)
            if asyncio.iscoroutinefunction(handler):
                output = asyncio.run(handler(input_value))
            else:
                output = handler(input_value)
            duration_ms = max(0, round((time.perf_counter() - started) * 1000))
            self._outbox.put(
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
            self._send_error(body.invoke_id, "INTERNAL", str(exc))

    def _send_error(self, invoke_id: str, code: str, message: str) -> None:
        self._outbox.put(
            pb.SessionRequest(
                invoke_error=pb.InvokeError(
                    invoke_id=invoke_id,
                    error=pb.InvokeErrorDetail(
                        code=code, message=message, retriable=False
                    ),
                )
            )
        )
