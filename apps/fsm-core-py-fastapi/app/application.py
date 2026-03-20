import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from fsm_core_db import create_pool as create_db_pool, close_pool as close_db_pool
from app.routers import index, fsm, fsmworker, fsmpromise

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ──────────────────────────────────────────────────────────────
    if settings.DB_TYPE in ("postgres", "supabase_and_postgres"):
        if not settings.DATABASE_URL:
            raise RuntimeError("DATABASE_URL must be set when DB_TYPE includes postgres")
        try:
            pool = await create_db_pool(str(settings.DATABASE_URL))
            app.state.db_pool = pool
            logger.info("asyncpg pool created")
        except Exception as e:
            logger.warning(f"Could not connect to database at startup: {e}. Routes requiring DB will fail.")
            app.state.db_pool = None

    if settings.DB_TYPE in ("supabase", "supabase_and_postgres"):
        if not settings.SUPABASE_URL or not settings.SUPABASE_SERVICE_ROLE_KEY:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set when DB_TYPE includes supabase"
            )
        from supabase import create_client
        app.state.supabase = create_client(
            str(settings.SUPABASE_URL),
            settings.SUPABASE_SERVICE_ROLE_KEY,
        )
        logger.info("Supabase client created")

    yield

    # ── Shutdown ─────────────────────────────────────────────────────────────
    if hasattr(app.state, "db_pool"):
        await close_db_pool(app.state.db_pool)
        logger.info("asyncpg pool closed")


def create_app() -> FastAPI:
    app = FastAPI(
        title="FSM API",
        version="1.0.0",
        description="Finite State Machine REST API backed by PostgreSQL",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.CORS_ORIGIN],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(index.router)
    app.include_router(fsm.router)
    app.include_router(fsmworker.router)
    app.include_router(fsmpromise.router)

    # Scalar API reference UI at /docs (mirrors configure-open-api.ts + Scalar)
    @app.get("/docs", include_in_schema=False)
    async def scalar_docs():
        from scalar_fastapi import get_scalar_api_reference
        return get_scalar_api_reference(
            openapi_url=app.openapi_url,
            title="FSM API",
        )

    return app
