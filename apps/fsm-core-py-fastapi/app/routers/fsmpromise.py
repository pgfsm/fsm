import asyncio
import logging
import asyncpg
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.db.pool import get_db
from app.db.queue import pgmq_queue_exists
from app.models.fsmpromise import FsmPromiseCreateRequest, DataResponse, ErrorResponse
from app.workers.fsmpromiseworker import start_fsm_promise_worker

logger = logging.getLogger(__name__)

router = APIRouter(tags=["fsmpromise"])

active_promise_locks: dict[str, bool] = {}
active_promise_tasks: dict[str, asyncio.Task] = {}


@router.get("/fsmpromise", response_model=DataResponse)
async def list_fsmpromise():
    return {"data": active_promise_locks}


@router.post(
    "/fsmpromise",
    response_model=DataResponse,
    responses={500: {"model": ErrorResponse}},
)
async def create_fsmpromise(
    body: FsmPromiseCreateRequest,
    pool: asyncpg.Pool = Depends(get_db),
):
    if not body.promise_name:
        return JSONResponse(status_code=500, content={"error": "Missing promise_name"})
    promise_name = body.promise_name
    try:
        queue_exists = await pgmq_queue_exists(pool, promise_name)
        if not queue_exists:
            logger.warning(f"PGMQ queue for promise '{promise_name}' does not exist.")
            # Returns HTTP 200 by design (mirrors TS behaviour)
            return {"error": "PGMQ queue does not exist"}

        active_promise_locks[promise_name] = True
        task = asyncio.create_task(
            _run_promise_worker_guarded(
                pool, promise_name, promise_name, body.promise_version
            )
        )
        task.add_done_callback(lambda t: active_promise_tasks.pop(promise_name, None))
        active_promise_tasks[promise_name] = task

        return {
            "data": f'fsm promise with fsm promise name "{promise_name}" is started'
        }
    except Exception:
        logger.exception("Error in create_fsmpromise")
        return JSONResponse(status_code=500, content={"error": "Unexpected error"})


async def _run_promise_worker_guarded(
    pool: asyncpg.Pool,
    queue_name: str,
    promise_name: str,
    promise_version: str,
) -> None:
    try:
        await start_fsm_promise_worker(pool, queue_name, promise_name, promise_version)
    except Exception:
        logger.exception(f"FSM Promise worker for '{queue_name}' stopped unexpectedly")
    finally:
        active_promise_locks.pop(queue_name, None)
        active_promise_tasks.pop(queue_name, None)
