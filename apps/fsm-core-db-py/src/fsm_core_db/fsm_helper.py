import json
from typing import Any, Optional
import asyncpg

from .constants import FSM_SCHEMA, FSM_SCHEMA_FN_VERSION
from .pg_utils import to_jsonb_param

_V = FSM_SCHEMA_FN_VERSION

MICROSTEP_FN = f"{FSM_SCHEMA}.microstep_{_V}"
SELECT_TRANSITIONS_FN = f"{FSM_SCHEMA}.select_all_transitions_{_V}"
LOAD_FSM_STATE_FN = f"{FSM_SCHEMA}.load_fsm_state_from_json_{_V}"
LOAD_FSM_TRANSITION_FN = f"{FSM_SCHEMA}.load_fsm_transition_from_json_{_V}"
LOAD_FSM_FROM_JSON_FN = f"{FSM_SCHEMA}.load_fsm_from_json_{_V}"
RESOLVE_STATE_VALUE_FN = f"{FSM_SCHEMA}.resolve_state_value_{_V}"


async def select_transitions(
    pool: asyncpg.Pool,
    event_name: str,
    source_state_value_set: Any,
    fsm_name: str,
    fsm_version: str,
) -> list[dict]:
    """
    Select all valid transitions for the given event and current state nodes.
    Mirrors selectTransitions() in fsm-helper.ts.
    """
    sql = f"""
        SELECT * FROM {SELECT_TRANSITIONS_FN}(
            $1::text, $2::jsonb, $3::text, $4::text
        );
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            sql, event_name, to_jsonb_param(source_state_value_set), fsm_name, fsm_version
        )
    return [dict(r) for r in rows]


async def perform_microstep(
    pool: asyncpg.Pool,
    transition_record: Optional[dict],
    event_name: str,
    state_value_node_set: Any,
    fsm_name: str,
    fsm_version: str,
) -> dict:
    """
    Execute a single microstep for the FSM, returning updated state and actions.
    Mirrors performMicrostep() in fsm-helper.ts.
    """
    transition_json = json.dumps(transition_record) if transition_record is not None else None
    node_array = list(state_value_node_set) if isinstance(state_value_node_set, (list, set)) else []
    sql = f"""
        SELECT {MICROSTEP_FN}(
            CASE
                WHEN $1::jsonb IS NULL THEN NULL::{FSM_SCHEMA}.fsm_transitions
                ELSE jsonb_populate_record(NULL::{FSM_SCHEMA}.fsm_transitions, $1::jsonb)
            END,
            $2::text,
            $3::text[],
            $4::text,
            $5::text
        ) AS result;
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(sql, transition_json, event_name, node_array, fsm_name, fsm_version)
    if row and row["result"] is not None:
        result = row["result"]
        return dict(result) if hasattr(result, "keys") else result
    return {
        "updated_state_value_node_set": [],
        "updated_state_value": None,
        "exit_actions": None,
        "entry_actions": None,
        "initial_actions": None,
        "transition_actions": None,
    }


async def load_fsm_state_from_json(
    pool: asyncpg.Pool, fsm_name: str, fsm_version: str, state_json: Any
) -> Optional[dict]:
    """Mirrors loadFsmStateFromJsonV2() in fsm-helper.ts."""
    sql = f"SELECT * FROM {LOAD_FSM_STATE_FN}($1::text, $2::text, $3::jsonb);"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(sql, fsm_name, fsm_version, to_jsonb_param(state_json))
    return dict(row) if row else None


async def load_fsm_transition_from_json(
    pool: asyncpg.Pool, fsm_name: str, fsm_version: str, transition_json: Any
) -> Optional[dict]:
    """Mirrors loadFsmTransitionFromJsonV2() in fsm-helper.ts."""
    sql = f"SELECT * FROM {LOAD_FSM_TRANSITION_FN}($1::text, $2::text, $3::jsonb);"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(sql, fsm_name, fsm_version, to_jsonb_param(transition_json))
    return dict(row) if row else None


async def load_fsm_from_json_v2(
    pool: asyncpg.Pool,
    fsm_name: str,
    fsm_version: str,
    fsm_json: Any,
    root_node_text: Optional[str] = None,
) -> Optional[dict]:
    """Calls fsm_core.load_fsm_from_json_v2 — orchestrates state + transition load with schema validation and caching."""
    sql = f"""
        SELECT {LOAD_FSM_FROM_JSON_FN}(
            $1::jsonb, $2::text, $3::text, $4::text
        ) AS result;
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            sql, to_jsonb_param(fsm_json), root_node_text, fsm_name, fsm_version
        )
    if row and row["result"] is not None:
        result = row["result"]
        return dict(result) if hasattr(result, "keys") else result
    return None


async def resolve_state_value(
    pool: asyncpg.Pool, fsm_instance_id: str
) -> Optional[dict]:
    """Mirrors resolveStateValue() in fsm-helper.ts."""
    sql = f"SELECT {RESOLVE_STATE_VALUE_FN}($1::uuid) AS result;"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(sql, fsm_instance_id)
    if row and row["result"] is not None:
        result = row["result"]
        return dict(result) if hasattr(result, "keys") else result
    return None
