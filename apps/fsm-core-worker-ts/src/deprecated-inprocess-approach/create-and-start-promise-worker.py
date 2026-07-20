#!/usr/bin/env python3
"""
Deprecated in-process promise worker entry point for Python actors.

Usage:
    python3 create-and-start-promise-worker.py \
        <module_path> <fn_name> <queue_name> \
        <fsm_promise_name> <fsm_promise_type> <fsm_promise_version>

Environment:
    DATABASE_URL  PostgreSQL connection string

Thin wrapper kept for deprecated_inprocess_worker.ts's
create-and-start-promise-worker CLI command: creates the PGMQ queue (mirroring
createAndStartPromiseWorker.ts's createPgmqQueue call), then delegates the
polling loop to asyncOperationWorkerlet/fsmpromiseworker.py — the
non-deprecated implementation also used by asyncOperationWorkerlet.ts to
spawn Python actors — kept in sync here rather than duplicated.
"""

import os
import sys
import importlib.util
from pathlib import Path

_FSMPROMISEWORKER_PATH = (
    Path(__file__).resolve().parent.parent
    / "asyncOperationWorkerlet"
    / "fsmpromiseworker.py"
)
_spec = importlib.util.spec_from_file_location(
    "fsmpromiseworker", _FSMPROMISEWORKER_PATH
)
if _spec is None or _spec.loader is None:
    raise ImportError(f"Cannot load module from {_FSMPROMISEWORKER_PATH}")
fsmpromiseworker = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fsmpromiseworker)


def _create_queue(queue_name: str) -> None:
    try:
        import psycopg2
    except ImportError:
        print("psycopg2 not installed — run: pip install psycopg2-binary", file=sys.stderr)
        sys.exit(1)

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)

    conn = psycopg2.connect(database_url)
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("SELECT pgmq.create(%s)", (queue_name,))
    cur.close()
    conn.close()


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

    _create_queue(_queue_name)

    try:
        fsmpromiseworker.run(
            _module_path,
            _fn_name,
            _queue_name,
            _promise_name,
            _promise_type,
            _promise_version,
        )
    except KeyboardInterrupt:
        sys.exit(0)
