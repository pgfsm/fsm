import asyncio
import logging
from typing import Optional
import asyncpg

from app.db.queue import read_message
from app.workers.fsmpromiseworker_helper import process_fsm_promise_queue_message

logger = logging.getLogger(__name__)
VISIBILITY_TIMEOUT = 30


async def start_fsm_promise_worker(
    pool: asyncpg.Pool,
    queue_name: str,
    fsm_promise_name: str,
    fsm_promise_version: Optional[str] = None,
) -> None:
    logger.info(
        f"FSM Promise worker started | queue={queue_name} promise={fsm_promise_name} version={fsm_promise_version}"
    )

    while True:
        messages = await read_message(pool, queue_name, VISIBILITY_TIMEOUT)
        if not messages:
            await asyncio.sleep(1)
            continue

        for msg in messages:
            if not (msg.get("message") and msg.get("msg_id")):
                continue
            try:
                await process_fsm_promise_queue_message(
                    pool,
                    queue_name,
                    msg,
                    fsm_promise_name,
                    str(fsm_promise_version) if fsm_promise_version else None,
                )
            except Exception:
                logger.exception(
                    f"Error processing FSM promise message in queue '{queue_name}'"
                )
