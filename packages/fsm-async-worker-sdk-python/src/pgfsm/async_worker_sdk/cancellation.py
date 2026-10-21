"""The cancellation token every handler gets (SPEC-012).

Handlers run on their own threads, so the token is thread-safe: check
`token.cancelled` between steps, call `token.raise_if_cancelled()`, or block on
`token.wait(timeout)` instead of `time.sleep`.
"""

from __future__ import annotations

import threading
from typing import Optional

from pgfsm.sidecargateway.v1 import sidecar_gateway_pb2 as pb

#: Why the gateway cancels an invoke: the proto's CancelReason, by name.
CANCEL_REASONS = ("UNSPECIFIED", "STATE_EXITED", "TIMEOUT", "SHUTDOWN")


def cancel_reason_name(reason: int) -> str:
    """A CancelReason number's name, e.g. 2 -> "TIMEOUT"; an unknown number
    counts as "UNSPECIFIED"."""
    try:
        name = pb.CancelReason.Name(reason)
    except ValueError:
        return "UNSPECIFIED"
    return name.removeprefix("CANCEL_REASON_")


class InvokeCancelledError(Exception):
    """Raised by `CancellationToken.raise_if_cancelled()`: the invoke was
    cancelled, for `reason` ("STATE_EXITED", "TIMEOUT" or "SHUTDOWN")."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"invoke cancelled ({reason})")
        self.reason = reason


class CancellationToken:
    """Cancelled when the gateway cancels this invoke, or when the worker's
    session with the gateway ends ("SHUTDOWN")."""

    def __init__(self) -> None:
        self._event = threading.Event()
        self._lock = threading.Lock()
        self._reason: Optional[str] = None

    @property
    def cancelled(self) -> bool:
        """Whether the invoke was cancelled."""
        return self._event.is_set()

    @property
    def reason(self) -> Optional[str]:
        """Why it was cancelled, or None if it wasn't."""
        return self._reason

    def wait(self, timeout: Optional[float] = None) -> bool:
        """Blocks until the invoke is cancelled or `timeout` seconds pass;
        returns whether it was cancelled."""
        return self._event.wait(timeout)

    def raise_if_cancelled(self) -> None:
        """Raises InvokeCancelledError if the invoke was cancelled."""
        if self._event.is_set():
            raise InvokeCancelledError(self._reason or "UNSPECIFIED")

    def _cancel(self, reason: str) -> None:
        """Cancels with `reason`; the first reason wins."""
        with self._lock:
            if self._event.is_set():
                return
            self._reason = reason
            self._event.set()

    def __repr__(self) -> str:
        return f"CancellationToken(reason={self._reason!r})"
