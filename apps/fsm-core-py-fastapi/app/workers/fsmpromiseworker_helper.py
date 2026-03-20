import asyncio
import logging
import random
from datetime import datetime, timezone
from typing import Optional
import asyncpg

from app.db.fsm_instance import archive_event_from_fsm_promise_type_worker

logger = logging.getLogger(__name__)


async def process_fsm_promise_queue_message(
    pool: asyncpg.Pool,
    queue_name: str,
    msg: dict,
    promise_queue_name: str,
    promise_version: Optional[str] = None,
) -> None:

    msg_id = msg.get("msg_id")
    event_data = msg.get("message", {})
    send_to_parent_queue_id = event_data.get("send_to_parent_queue_id")
    send_event_name = event_data.get("send_event_name_to_parent_queue_id")

    # Simulate async promise work (stub — replace with real actor logic)
    await asyncio.sleep(0.3)
    is_success = random.random() < 0.5

    if is_success:
        resolved_event_name = f"xstate.done.actor.{send_event_name}"
        event_output = {"result": "Promise fulfilled successfully"}
        event_status = "succeeded"
    else:
        resolved_event_name = f"xstate.error.actor.{send_event_name}"
        event_output = {"error": "Promise failed"}
        event_status = "failed"

    event_duration = 300
    event_finished_at = datetime.now(timezone.utc).isoformat()

    try:
        result = await archive_event_from_fsm_promise_type_worker(
            pool,
            promise_queue_name,
            msg_id,
            send_to_parent_queue_id,
            resolved_event_name,
            event_output,
            event_status,
            event_duration,
            event_finished_at,
        )
        logger.info(f"Promise archived: {result}")
    except Exception:
        logger.exception("Error calling archive_event_from_fsm_promise_type_worker")
