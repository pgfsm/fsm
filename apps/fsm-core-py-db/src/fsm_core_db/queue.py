import asyncpg

from .constants import QUEUE_SCHEMA

READ_FN = f"{QUEUE_SCHEMA}.read"
DELETE_FN = f"{QUEUE_SCHEMA}.delete"
ARCHIVE_FN = f"{QUEUE_SCHEMA}.archive"
LIST_QUEUES_FN = f"{QUEUE_SCHEMA}.list_queues"


async def read_message(
    pool: asyncpg.Pool, queue_name: str, vt: int, qty: int = 1
) -> list[dict]:
    """
    Read up to `qty` messages from a pgmq queue with a visibility timeout of `vt` seconds.
    Mirrors readMessage() in queue.ts.
    """
    sql = f"SELECT * FROM {READ_FN}($1::text, $2::integer, $3::integer);"
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, queue_name, vt, qty)
    return [dict(r) for r in rows]


async def delete_message(pool: asyncpg.Pool, queue_name: str, msg_id: int) -> None:
    """
    Permanently delete a message from a pgmq queue.
    Mirrors deleteMessage() in queue.ts.
    """
    sql = f"SELECT * FROM {DELETE_FN}($1::text, $2::bigint);"
    async with pool.acquire() as conn:
        await conn.execute(sql, queue_name, msg_id)


async def archive_message(pool: asyncpg.Pool, queue_name: str, msg_id: int) -> None:
    """
    Move a message to the pgmq archive table.
    Mirrors archiveMessage() in queue.ts.
    """
    sql = f"SELECT * FROM {ARCHIVE_FN}($1::text, $2::bigint);"
    async with pool.acquire() as conn:
        await conn.execute(sql, queue_name, msg_id)


async def pgmq_queue_exists(pool: asyncpg.Pool, queue_name: str) -> bool:
    """
    Return True if a pgmq queue with the given name exists.
    Mirrors pgmqQueueExists() in queue.ts.
    """
    if not queue_name:
        return False
    sql = f"SELECT * FROM {LIST_QUEUES_FN}();"
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql)
    return any(
        r.get("name") == queue_name or r.get("queue_name") == queue_name
        for r in rows
    )
