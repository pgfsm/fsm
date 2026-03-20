from dataclasses import dataclass
from typing import Any


@dataclass
class DBDeps:
    """Database dependency container — mirrors the DBDeps interface in fsm-core-db."""
    db: Any  # asyncpg.Pool or supabase client
    use_supabase: bool = False
