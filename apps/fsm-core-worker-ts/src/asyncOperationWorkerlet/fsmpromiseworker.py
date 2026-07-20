#!/usr/bin/env python3
"""
Promise worker (while-loop runner) for Python actors.

Usage:
    python3 fsmpromiseworker.py \
        <module_path> <fn_name> <queue_name> \
        <fsm_promise_name> <fsm_promise_type> <fsm_promise_version>

Environment:
    DATABASE_URL  PostgreSQL connection string

Python counterpart of asyncOperationWorkerlet/fsmpromiseworker.ts: expects the
named PGMQ queue to already exist (it does not create one — the caller is
responsible, matching startFSMPromiseWorker.ts's pgmqQueueExists guard), then
polls it with a 30s visibility timeout, invokes the actor function for each
message, and archives the result through
fsm_core.archive_event_from_fsm_promise_type_worker_v2 — the same RPC the
TypeScript promise worker calls — so parent-FSM routing behaves identically
regardless of actor language. Spawned as a subprocess by
asyncOperationWorkerlet.ts for lang="python" actors. Uses psycopg2
(pip install psycopg2-binary).
"""

import sys
import os
import json
import time
import signal
import asyncio
import importlib.util
from datetime import datetime, timezone

VISIBILITY_TIMEOUT = 30
POLL_IDLE_SECONDS = 1

_shutdown = False


def _handle_shutdown(signum, frame):
    global _shutdown
    _shutdown = True


def _queue_exists(cur, queue_name: str) -> bool:
    cur.execute("SELECT * FROM pgmq.list_queues()")
    return any(row["queue_name"] == queue_name for row in cur.fetchall())


def _load_fn(module_path: str, fn_name: str):
    spec = importlib.util.spec_from_file_location("_actor", module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load module from {module_path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    fn = getattr(mod, fn_name, None)
    if not callable(fn):
        raise ValueError(f"'{fn_name}' not found or not callable in {module_path}")
    return fn


def _process_message(cur, psycopg2_extras, queue_name, promise_queue_type, promise_queue_version, msg, actor_fn, is_async):
    msg_id = msg["msg_id"]
    payload = msg["message"] or {}
    event_data = payload.get("eventData") or {}
    event_payload = event_data.get("eventPayload")
    event_action_type = event_data.get("actionType") or ""
    event_name_base = payload.get("sendToParentQueueIdEventName") or ""
    send_to_parent_queue_id = payload.get("sendToParentQueueId") or ""
    queue_msg_id = payload.get("queueMsgId")
    send_to_parent_queue_id_msg_id = str(queue_msg_id) if queue_msg_id is not None else ""

    started = datetime.now(timezone.utc)

    try:
        output = (
            asyncio.run(actor_fn(event_payload)) if is_async else actor_fn(event_payload)
        )
        event_name = f"xstate.done.actor.{event_name_base}"
        status = "succeeded"
        error_message = None
    except Exception as exc:
        output = {"error": str(exc)}
        event_name = f"xstate.error.actor.{event_name_base}"
        status = "failed"
        error_message = str(exc)

    finished = datetime.now(timezone.utc)
    duration_ms = int((finished - started).total_seconds() * 1000)

    cur.execute(
        """
        SELECT * FROM fsm_core.archive_event_from_fsm_promise_type_worker_v2(
            %s::text, %s::text, %s::text, %s::bigint,
            %s::text, %s::text, %s::jsonb, %s::integer,
            %s::uuid, %s::text, %s::timestamptz, %s::integer,
            %s::timestamptz, %s::text, %s::jsonb, %s::text
        )
        """,
        (
            queue_name,
            promise_queue_type,
            promise_queue_version,
            msg_id,
            event_name,
            event_action_type,
            psycopg2_extras.Json(event_payload),
            0,
            send_to_parent_queue_id,
            send_to_parent_queue_id_msg_id,
            started,
            duration_ms,
            finished,
            status,
            psycopg2_extras.Json(output),
            error_message,
        ),
    )

    print(
        json.dumps({
            "queue": queue_name,
            "msg_id": str(msg_id),
            "event": event_name,
            "status": status,
            "duration_ms": duration_ms,
            "error": error_message,
        }),
        flush=True,
    )


def run(
    module_path: str,
    fn_name: str,
    queue_name: str,
    fsm_promise_name: str,
    fsm_promise_type: str,
    fsm_promise_version: str,
) -> None:
    signal.signal(signal.SIGTERM, _handle_shutdown)
    signal.signal(signal.SIGINT, _handle_shutdown)

    try:
        import psycopg2
        import psycopg2.extras
    except ImportError:
        print("psycopg2 not installed — run: pip install psycopg2-binary", file=sys.stderr)
        sys.exit(1)

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)

    actor_fn = _load_fn(module_path, fn_name)
    is_async = asyncio.iscoroutinefunction(actor_fn)

    conn = psycopg2.connect(database_url)
    conn.autocommit = True
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    if not _queue_exists(cur, queue_name):
        print(
            json.dumps({
                "event": "queue_missing",
                "queue": queue_name,
                "fn": fn_name,
            }),
            file=sys.stderr,
            flush=True,
        )
        cur.close()
        conn.close()
        return

    print(
        json.dumps({"event": "started", "queue": queue_name, "fn": fn_name}),
        flush=True,
    )

    while not _shutdown:
        cur.execute(
            "SELECT * FROM pgmq.read(%s, %s, 1)",
            (queue_name, VISIBILITY_TIMEOUT),
        )
        msgs = cur.fetchall()

        if not msgs:
            time.sleep(POLL_IDLE_SECONDS)
            continue

        for msg in msgs:
            try:
                _process_message(
                    cur,
                    psycopg2.extras,
                    queue_name,
                    fsm_promise_type,
                    fsm_promise_version,
                    msg,
                    actor_fn,
                    is_async,
                )
            except Exception as exc:
                print(
                    json.dumps({
                        "queue": queue_name,
                        "msg_id": str(msg.get("msg_id")),
                        "event": "error",
                        "error": str(exc),
                    }),
                    file=sys.stderr,
                    flush=True,
                )

    cur.close()
    conn.close()
    print(json.dumps({"event": "stopped", "queue": queue_name}), flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 7:
        print(
            f"Usage: {sys.argv[0]} "
            "<module_path> <fn_name> <queue_name> "
            "<fsm_promise_name> <fsm_promise_type> <fsm_promise_version>",
            file=sys.stderr,
        )
        sys.exit(2)

    _, _module_path, _fn_name, _queue_name, _promise_name, _promise_type, _promise_version = sys.argv

    try:
        run(_module_path, _fn_name, _queue_name, _promise_name, _promise_type, _promise_version)
    except KeyboardInterrupt:
        sys.exit(0)
