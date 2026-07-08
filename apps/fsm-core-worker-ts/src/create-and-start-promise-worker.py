#!/usr/bin/env python3
"""
Promise worker for Python actors.

Usage:
    python3 create-and-start-promise-worker.py \
        <module_path> <fn_name> <queue_name> \
        <fsm_promise_name> <fsm_promise_type> <fsm_promise_version>

Environment:
    DATABASE_URL  PostgreSQL connection string

Polls the named PGMQ queue, calls the actor function for each message,
then archives the message. Uses psycopg2 (pip install psycopg2-binary).
"""

import sys
import os
import json
import time
import asyncio
import importlib.util
from datetime import datetime, timezone


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


def _run(
    module_path: str,
    fn_name: str,
    queue_name: str,
    fsm_promise_name: str,
    fsm_promise_type: str,
    fsm_promise_version: str,
) -> None:
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

    cur.execute("SELECT pgmq.create(%s)", (queue_name,))
    print(
        json.dumps({"event": "started", "queue": queue_name, "fn": fn_name}),
        flush=True,
    )

    while True:
        cur.execute("SELECT * FROM pgmq.read(%s, 30, 1)", (queue_name,))
        msgs = cur.fetchall()

        if not msgs:
            time.sleep(1)
            continue

        for msg in msgs:
            msg_id = msg["msg_id"]
            payload = msg["message"]
            started = datetime.now(timezone.utc)

            try:
                output = (
                    asyncio.run(actor_fn(payload)) if is_async else actor_fn(payload)
                )
                finished = datetime.now(timezone.utc)
                event_name = f"xstate.done.actor.{fn_name}"
                status = "success"
                error = None
            except Exception as exc:
                finished = datetime.now(timezone.utc)
                output = None
                event_name = f"xstate.error.actor.{fn_name}"
                status = "error"
                error = str(exc)

            duration = (finished - started).total_seconds()
            cur.execute("SELECT pgmq.archive(%s, %s)", (queue_name, msg_id))

            print(
                json.dumps({
                    "queue": queue_name,
                    "msg_id": str(msg_id),
                    "event": event_name,
                    "status": status,
                    "duration": duration,
                    "error": error,
                }),
                flush=True,
            )


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
        _run(_module_path, _fn_name, _queue_name, _promise_name, _promise_type, _promise_version)
    except KeyboardInterrupt:
        sys.exit(0)
