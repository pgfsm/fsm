from pathlib import Path
from typing import Literal, Optional
from pydantic import AnyHttpUrl, AnyUrl, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Root .env is 4 levels up from this file (apps/fsm-core-py-fastapi/app/config.py)
_ROOT_ENV = Path(__file__).resolve().parent.parent.parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_ROOT_ENV),
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    NODE_ENV: str = "development"
    PORT: int = 9999
    LOG_LEVEL: Literal["fatal", "error", "warn", "info", "debug", "trace", "silent"] = "info"
    DB_TYPE: Literal["postgres", "supabase", "supabase_and_postgres"] = "postgres"

    SUPABASE_URL: Optional[AnyHttpUrl] = None
    SUPABASE_SERVICE_ROLE_KEY: Optional[str] = None
    SUPABASE_ANON_KEY: Optional[str] = None

    DATABASE_URL: Optional[str] = None  # allows postgresql://, postgres://, etc.
    DATABASE_AUTH_TOKEN: Optional[str] = None

    CORS_ORIGIN: str = "http://localhost:5173"
    PARSEFSM: str = "false"

    @model_validator(mode="after")
    def check_production_auth_token(self) -> "Settings":
        if self.NODE_ENV == "production" and not self.DATABASE_AUTH_TOKEN:
            raise ValueError(
                "DATABASE_AUTH_TOKEN must be set when NODE_ENV is 'production'"
            )
        return self


settings = Settings()
