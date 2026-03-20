import asyncio
import logging
import asyncpg
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.db.pool import get_db
from app.db.fsm_instance import is_fsm_instance_present
from app.db.fsm_instance_lock import try_fsm_db_lock
from app.models.fsmworker import FsmWorkerCreateRequest, DataResponse, ErrorResponse
from app.routers.fsm import active_fsm_locks, active_fsm_tasks, _run_worker_guarded

logger = logging.getLogger(__name__)

router = APIRouter(tags=["fsmworker"])


@router.get("/fsmworker", response_model=DataResponse)
async def list_fsmworker():
    return {"data": active_fsm_locks}


@router.post(
    "/fsmworker",
    response_model=DataResponse,
    responses={500: {"model": ErrorResponse}},
)
async def create_fsmworker(
    body: FsmWorkerCreateRequest,
    pool: asyncpg.Pool = Depends(get_db),
):
    queue = body.queue
    if not queue:
        return JSONResponse(status_code=500, content={"error": "Missing queue parameter"})
    try:
        fsm_instance = await is_fsm_instance_present(pool, queue)
        if not fsm_instance:
            return JSONResponse(status_code=500, content={"error": "Invalid queue id"})

        if active_fsm_locks.get(queue):
            return JSONResponse(
                status_code=500,
                content={"error": f"fsmworker already running for queue '{queue}'"},
            )

        locked = await try_fsm_db_lock(pool, queue)
        if not locked:
            return JSONResponse(
                status_code=500,
                content={"error": f"fsmworker already running for queue '{queue}'"},
            )

        active_fsm_locks[queue] = True
        task = asyncio.create_task(
            _run_worker_guarded(
                pool,
                queue,
                fsm_instance.get("fsm_name", ""),
                str(fsm_instance.get("fsm_version", "")),
            )
        )
        task.add_done_callback(lambda t: active_fsm_tasks.pop(queue, None))
        active_fsm_tasks[queue] = task

        return {"data": None}
    except Exception:
        logger.exception("Error in create_fsmworker")
        return JSONResponse(status_code=500, content={"error": "Unexpected error"})
