import asyncpg

from .constants import FSM_SCHEMA

LOCK_FN = f"{FSM_SCHEMA}.lock_fsm_instance"
UNLOCK_FN = f"{FSM_SCHEMA}.unlock_fsm_instance"
LOCKED_BY = "fsm-core-py"


async def try_fsm_db_lock(pool: asyncpg.Pool, fsm_instance_id: str) -> bool:
    """
    Attempt to acquire an advisory lock on an FSM instance.
    Mirrors tryFSMDBLock() in fsm-instance-lock.ts.
    """
    sql = f"SELECT {LOCK_FN}($1::uuid, $2::text) AS locked;"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(sql, fsm_instance_id, LOCKED_BY)
    return bool(row["locked"]) if row else False


async def release_fsm_db_lock(pool: asyncpg.Pool, fsm_instance_id: str) -> bool:
    """
    Release a previously acquired advisory lock on an FSM instance.
    Mirrors releaseFSMDBLock() in fsm-instance-lock.ts.
    """
    sql = f"SELECT {UNLOCK_FN}($1::uuid) AS unlocked;"
    async with pool.acquire() as conn:
        row = await conn.fetchrow(sql, fsm_instance_id)
    return bool(row["unlocked"]) if row else False
