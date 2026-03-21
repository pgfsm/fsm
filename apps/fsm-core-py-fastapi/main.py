import uvicorn
from pathlib import Path
import asyncpg

from app.config import settings
from app.application import create_app
from fsm_py_compiler import load_and_verify_fsm_from_folders

# Absolute path to apps/fsm-core-example/fsm — two levels up from this file
FSM_EXAMPLE_FOLDER = str(Path(__file__).resolve().parent.parent / "fsm-core-example" / "fsm")


async def _create_fsm_app(pool: asyncpg.Pool) -> None:
    await load_and_verify_fsm_from_folders(pool, FSM_EXAMPLE_FOLDER, "fsm")


app = create_app(create_fsm_app=_create_fsm_app)

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=settings.PORT,
        reload=settings.NODE_ENV == "development",
        log_level=settings.LOG_LEVEL.lower(),
    )
