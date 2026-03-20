from typing import Any, Optional
import asyncpg

from .constants import FSM_SCHEMA, FSM_SCHEMA_FN_VERSION
from .pg_utils import to_jsonb_param

_V = FSM_SCHEMA_FN_VERSION

FSM_INSTANCE_TABLE = f"{FSM_SCHEMA}.fsm_instance"
CREATE_FSM_INSTANCE_FN = f"{FSM_SCHEMA}.create_fsm_instance_from_name_{_V}"
ARCHIVE_FSM_TYPE_WORKER_FN = f"{FSM_SCHEMA}.archive_event_from_fsm_type_worker_{_V}"
ARCHIVE_FSM_PROMISE_TYPE_WORKER_FN = f"{FSM_SCHEMA}.archive_event_from_fsm_promise_type_worker_{_V}"
GET_FSM_DATA_FN = f"{FSM_SCHEMA}.get_fsm_data_{_V}"
GET_FSM_DATA_RESOLVE_STATE_VALUE_FN = f"{FSM_SCHEMA}.get_fsm_data_resolve_state_value_{_V}"
SEND_EVENT_FN = f"{FSM_SCHEMA}.send_event_to_queue_with_event_logs_{_V}"


async def is_fsm_instance_present(
    pool: asyncpg.Pool, fsm_instance_id: str
) -> Optional[dict]:
    """
    Return the FSM instance row if it exists, else None.
    Mirrors isFSMInstancePresent() in fsm-instance.ts.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"SELECT * FROM {FSM_INSTANCE_TABLE} WHERE id = $1::uuid",
            fsm_instance_id,
        )
    return dict(row) if row else None


async def create_fsm_instance_from_name(
    pool: asyncpg.Pool,
    fsm_name: str,
    fsm_version: str,
    create_queue: bool = False,
) -> Optional[dict]:
    """
    Create a new FSM instance from a registered FSM name and version.
    Mirrors createFSMInstanceFromName() in fsm-instance.ts.
    """
    sql = f"SELECT {CREATE_FSM_INSTANCE_FN}($1::text, $2::text, $3::boolean) AS result;"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(sql, fsm_name, fsm_version, create_queue)
    if row and row["result"] is not None:
        result = row["result"]
        return dict(result) if hasattr(result, "keys") else result
    return None


async def get_fsm_data(
    pool: asyncpg.Pool, fsm_instance_id: str
) -> Optional[dict]:
    """
    Fetch raw FSM instance data by ID.
    Mirrors getFSMData() in fsm-instance.ts.
    """
    sql = f"SELECT {GET_FSM_DATA_FN}($1::uuid) AS result;"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(sql, fsm_instance_id)
    if row and row["result"] is not None:
        result = row["result"]
        return dict(result) if hasattr(result, "keys") else result
    return None


async def get_fsm_data_and_resolve_state_value(
    pool: asyncpg.Pool, fsm_instance_id: str
) -> Optional[dict]:
    """
    Fetch FSM instance data and resolve the current state value in one call.
    Mirrors getFSMDataAndResolveStateValue() in fsm-instance.ts.
    """
    sql = f"SELECT {GET_FSM_DATA_RESOLVE_STATE_VALUE_FN}($1::uuid) AS result;"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(sql, fsm_instance_id)
    if row and row["result"] is not None:
        result = row["result"]
        return dict(result) if hasattr(result, "keys") else result
    return None


async def send_fsm_event(
    pool: asyncpg.Pool,
    input_msg: dict,
    input_event_source: dict,
    input_delay: int = 0,
    input_event_name: Optional[str] = None,
    input_fsm_instance_id: Optional[str] = None,
) -> dict:
    """
    Send an event to an FSM instance queue with event logs.
    Mirrors sendFSMEvent() in fsm-instance.ts.
    """
    if not input_fsm_instance_id:
        raise ValueError("input_fsm_instance_id is required")
    sql = f"""
        SELECT * FROM {SEND_EVENT_FN}(
            $1::jsonb, $2::jsonb, $3::text, $4::integer, $5::uuid
        );
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            sql,
            to_jsonb_param(input_msg),
            to_jsonb_param(input_event_source),
            input_event_name,
            input_delay,
            input_fsm_instance_id,
        )
    return dict(row) if row else {
        "event_data": None,
        "fsm_instance_queue_name": "",
        "fsm_instance_queue_msg_id": 0,
        "fsm_instance_queue_event_logs_id": "",
    }


async def archive_event_from_fsm_type_worker(
    pool: asyncpg.Pool,
    remove_from_current_fsm_instance_queue_id: str,
    remove_current_queue_msg_id: int,
    remove_schedule_queue_msg_ids: Any,
    remove_promise_queue_msg_ids: Any,
    input_schedule_queue_data: Any,
    input_promise_queue_data: Any,
    total_schedule_queue_data: Any,
    total_promise_queue_data: Any,
    fsm_instance_data_save_fsm_status: Any,
    fsm_instance_data_save_fsm_state: Any,
    fsm_instance_data_save_fsm_context: Any,
    fsm_instance_data_save_fsm_xstate_state: Any,
) -> Optional[dict]:
    """
    Archive a processed worker event and persist new FSM state.
    Mirrors archive_event_from_fsm_type_worker() in fsm-instance.ts.
    """
    sql = f"""
        SELECT * FROM {ARCHIVE_FSM_TYPE_WORKER_FN}(
            $1::text, $2::bigint,
            $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb,
            $7::jsonb, $8::jsonb,
            $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb
        ) AS result;
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            sql,
            remove_from_current_fsm_instance_queue_id,
            remove_current_queue_msg_id,
            to_jsonb_param(remove_schedule_queue_msg_ids),
            to_jsonb_param(remove_promise_queue_msg_ids),
            to_jsonb_param(input_schedule_queue_data),
            to_jsonb_param(input_promise_queue_data),
            to_jsonb_param(total_schedule_queue_data),
            to_jsonb_param(total_promise_queue_data),
            to_jsonb_param(fsm_instance_data_save_fsm_status),
            to_jsonb_param(fsm_instance_data_save_fsm_state),
            to_jsonb_param(fsm_instance_data_save_fsm_context),
            to_jsonb_param(fsm_instance_data_save_fsm_xstate_state),
        )
    return dict(row) if row else None


async def archive_event_from_fsm_promise_type_worker(
    pool: asyncpg.Pool,
    promise_queue_name: str,
    queue_msg_id: int,
    send_to_parent_queue_id: str,
    send_event_name_to_parent_queue_id: str,
    event_output: dict,
    event_status: str = "completed",
    event_duration: Optional[int] = None,
    event_finished_at: Optional[str] = None,
) -> Optional[dict]:
    """
    Archive a processed promise worker event and send a completion event to the parent FSM.
    Mirrors archive_event_from_fsm_promise_type_worker() in fsm-instance.ts.
    """
    sql = f"""
        SELECT * FROM {ARCHIVE_FSM_PROMISE_TYPE_WORKER_FN}(
            $1::text, $2::bigint, $3::uuid, $4::text,
            $5::jsonb, $6::text, $7::integer, $8::timestamptz
        ) AS result;
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            sql,
            promise_queue_name,
            queue_msg_id,
            send_to_parent_queue_id,
            send_event_name_to_parent_queue_id,
            to_jsonb_param(event_output),
            event_status,
            event_duration,
            event_finished_at,
        )
    return dict(row) if row else None
