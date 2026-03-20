import asyncio
import logging
from typing import Union
import asyncpg
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.db.pool import get_db
from app.db.fsm_instance import create_fsm_instance_from_name, send_fsm_event
from app.db.fsm_instance_lock import try_fsm_db_lock, release_fsm_db_lock
from app.models.fsm import FsmCreateRequest, FsmSendRequest, DataResponse, ErrorResponse
from app.workers.fsmworker import start_fsm_worker

logger = logging.getLogger(__name__)

router = APIRouter(tags=["fsm"])

# Module-level lock registry shared with fsmworker router.
# { fsm_instance_id: True } — in-process workers only.
# NOTE: not safe across multiple processes; use a DB table for multi-process deployments.
active_fsm_locks: dict[str, bool] = {}
active_fsm_tasks: dict[str, asyncio.Task] = {}


async def _run_worker_guarded(
    pool: asyncpg.Pool,
    fsm_instance_id: str,
    fsm_name: str,
    fsm_version: str,
) -> None:
    try:
        await start_fsm_worker(pool, fsm_instance_id, fsm_name, fsm_version)
    except Exception:
        logger.exception(f"FSM worker for queue '{fsm_instance_id}' stopped unexpectedly")
    finally:
        active_fsm_locks.pop(fsm_instance_id, None)
        active_fsm_tasks.pop(fsm_instance_id, None)
        try:
            await release_fsm_db_lock(pool, fsm_instance_id)
        except Exception:
            logger.exception(f"Failed to release DB lock for '{fsm_instance_id}'")


@router.get("/fsm", response_model=DataResponse)
async def list_fsm():
    return {"data": active_fsm_locks}


@router.post(
    "/fsm",
    response_model=DataResponse,
    responses={500: {"model": ErrorResponse}},
)
async def create_fsm(
    body: FsmCreateRequest,
    pool: asyncpg.Pool = Depends(get_db),
):
    if not body.fsm_name:
        return JSONResponse(status_code=500, content={"error": "Missing fsm_name"})
    try:
        fsm_instance = await create_fsm_instance_from_name(
            pool, body.fsm_name, body.fsm_version, create_queue=True
        )
        if not fsm_instance or not fsm_instance.get("fsm_instance_id"):
            return JSONResponse(
                status_code=500, content={"error": "FSM instance creation failed"}
            )

        fsm_instance_id = str(fsm_instance["fsm_instance_id"])
        fsm_version = str(fsm_instance.get("fsm_version") or body.fsm_version)

        locked = await try_fsm_db_lock(pool, fsm_instance_id)
        if locked:
            active_fsm_locks[fsm_instance_id] = True
            task = asyncio.create_task(
                _run_worker_guarded(pool, fsm_instance_id, body.fsm_name, fsm_version)
            )
            task.add_done_callback(lambda t: active_fsm_tasks.pop(fsm_instance_id, None))
            active_fsm_tasks[fsm_instance_id] = task
        else:
            logger.error(f"FSM worker already running for queue '{fsm_instance_id}'")

        return {"data": fsm_instance}
    except Exception:
        logger.exception("Error in create_fsm")
        return JSONResponse(status_code=500, content={"error": "Unexpected error"})


@router.post(
    "/fsm/send",
    response_model=DataResponse,
    responses={500: {"model": ErrorResponse}},
)
async def send_fsm(
    body: FsmSendRequest,
    pool: asyncpg.Pool = Depends(get_db),
):
    if not body.fsm_instance_id or not body.event_data:
        return JSONResponse(
            status_code=500,
            content={"error": "Missing fsm_instance_id or event_data"},
        )
    try:
        result = await send_fsm_event(
            pool,
            input_msg=body.event_data,
            input_event_source={"source": "system"},
            input_delay=0,
            input_event_name=body.event_data.get("type"),
            input_fsm_instance_id=body.fsm_instance_id,
        )
        return {"data": result}
    except Exception:
        logger.exception("Error in send_fsm")
        return JSONResponse(status_code=500, content={"error": "Unexpected error"})
