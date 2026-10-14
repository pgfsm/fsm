# Actor: loadWork — the SPEC-007 acceptance suite's load (#458). Sleeps for
# `workMs`, then reports which worker processed the message, so the suite can
# tell replicas apart (`worker` is the pod name in Kubernetes).
import socket
import time

# How many invokes of this actor one worker runs at once. Above 1, the
# handler runs on several threads at once and must be thread-safe (no
# unguarded shared state, only thread-safe clients). Delivery is
# at-least-once, so the handler must also be idempotent: the same invoke can
# arrive more than once.
MAX_CONCURRENCY = 1

MAX_WORK_MS = 600_000


def loadWork(input):
    input = input if isinstance(input, dict) else {}
    try:
        work_ms = float(input.get("workMs") or 0)
    except (TypeError, ValueError):
        work_ms = 0
    time.sleep(min(max(work_ms, 0), MAX_WORK_MS) / 1000)
    return {
        "n": input.get("n"),
        "runId": input.get("runId"),
        "worker": socket.gethostname(),
        "language": "python",
    }
