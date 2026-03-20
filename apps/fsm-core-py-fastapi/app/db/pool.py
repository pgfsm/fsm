from typing import AsyncGenerator
from fsm_core_db import create_pool, close_pool
from fastapi import Request

__all__ = ["create_pool", "close_pool"]


async def get_db(request: Request) -> AsyncGenerator:
    """FastAPI dependency: yields the asyncpg pool from app.state."""
    yield request.app.state.db_pool
