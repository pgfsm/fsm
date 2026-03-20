import asyncio
import importlib
import logging
from typing import Any, Optional
import asyncpg

from app.db.queue import read_message
from app.db.fsm_instance import (
    get_fsm_data_and_resolve_state_value,
    archive_event_from_fsm_type_worker,
)
from app.workers.fsmworker_helper import macrostep_v2

logger = logging.getLogger(__name__)
VISIBILITY_TIMEOUT = 30


def _try_import(module_path: str) -> Optional[Any]:
    try:
        return importlib.import_module(module_path)
    except ImportError as err:
        logger.warning(f"Could not import module '{module_path}': {err}")
        return None


async def start_fsm_worker(
    pool: asyncpg.Pool,
    queue_name: str,
    fsm_name: str,
    fsm_version: str,
) -> None:
    logger.info(
        f"FSM worker started | queue={queue_name} fsm_name={fsm_name} fsm_version={fsm_version}"
    )

    actions_module = _try_import(f"fsmMachines.{fsm_name}.{fsm_version}.actions")
    delay_module = _try_import(f"fsmMachines.{fsm_name}.{fsm_version}.delay")

    while True:
        messages = await read_message(pool, queue_name, VISIBILITY_TIMEOUT)
        if not messages:
            await asyncio.sleep(1)
            continue

        for msg in messages:
            if not (msg.get("message") and msg.get("msg_id")):
                continue
            try:
                logger.info(f"Processing FSM message: {msg['message']}")
                fsm_data = await get_fsm_data_and_resolve_state_value(pool, queue_name)
                if not fsm_data:
                    logger.error(f"Could not fetch FSM data for queue '{queue_name}'")
                    continue

                result = await macrostep_v2(
                    pool,
                    queue_name,
                    msg,
                    fsm_data.get("fsm_instance_row"),
                    fsm_data.get("resolved_state_value"),
                    fsm_name,
                    fsm_version,
                    actions_module,
                    delay_module,
                )
                if result:
                    await archive_event_from_fsm_type_worker(
                        pool,
                        result["remove_from_current_fsm_instance_queue_id"],
                        result["remove_current_queue_msg_id"],
                        result["remove_schedule_queue_msg_ids"],
                        result["remove_promise_queue_msg_ids"],
                        result["new_schedule_queue_data"],
                        result["new_promise_queue_data"],
                        result["total_schedule_queue_data"],
                        result["total_promise_queue_data"],
                        result["fsm_instance_data_save_fsm_status"],
                        result["fsm_instance_data_save_fsm_state"],
                        result["fsm_instance_data_save_fsm_context"],
                        result["fsm_instance_data_save_fsm_xstate_state"],
                    )
            except Exception:
                logger.exception(f"Error processing FSM message in queue '{queue_name}'")
