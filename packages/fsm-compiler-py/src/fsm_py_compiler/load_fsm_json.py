"""
load_fsm_json.py
~~~~~~~~~~~~~~~~
Reads fsm.json files from versioned FSM folders and loads them into the database
via fsm_core_db. Mirrors loadFsmJSONFromFolders() in loadFsmJSON.ts — but skips
any XState machine generation (no machine.ts import, no JSON generation step).

Expected folder layout::

    <folder_path>/<fsm_name>/<version>/fsm.json
                                       fsm.machine.schema.json  (optional, validated separately)

where <version> matches v00–v99 (isVersionFolderName).
"""

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import asyncpg

from fsm_core_db import load_fsm_from_json_v2

from .util import is_version_folder_name, WorkflowType

logger = logging.getLogger(__name__)


@dataclass
class LoadResult:
    fsm_name: str
    fsm_version: str
    fsm_json_path: str
    state_load_ok: bool
    transition_load_ok: bool
    error: Optional[str] = None


async def load_fsm_json_from_folders(
    pool: asyncpg.Pool,
    folder_path: str,
    workflow_type: WorkflowType,
    skip_dirs: Optional[list[str]] = None,
) -> list[LoadResult]:
    """
    Walk ``folder_path`` for FSM name directories, then version sub-directories
    matching v00–v99. For each version that has an ``fsm.json``, load its states
    and transitions into the database.

    Args:
        pool:          asyncpg connection pool (from fsm_core_db.create_pool).
        folder_path:   Root directory containing ``<fsm_name>/<version>/fsm.json`` trees.
        workflow_type: Logical label for this set of FSMs (e.g. "fsm", "sharedFSM").
        skip_dirs:     FSM name directories to skip entirely.

    Returns:
        List of :class:`LoadResult` — one entry per version processed.
    """
    skip_dirs = skip_dirs or []
    base = Path(folder_path)
    results: list[LoadResult] = []

    if not base.is_dir():
        logger.error(f"folder_path does not exist or is not a directory: {folder_path}")
        return results

    for fsm_dir in sorted(base.iterdir()):
        if not fsm_dir.is_dir():
            continue
        fsm_name = fsm_dir.name
        if fsm_name in skip_dirs:
            logger.info(f"[{workflow_type}] Skipping '{fsm_name}'")
            continue

        for version_dir in sorted(fsm_dir.iterdir()):
            if not version_dir.is_dir():
                continue
            fsm_version = version_dir.name
            if not is_version_folder_name(fsm_version):
                continue

            fsm_json_path = version_dir / "fsm.json"
            if not fsm_json_path.exists():
                logger.warning(
                    f"[{workflow_type}] {fsm_name}/{fsm_version}: fsm.json not found, skipping"
                )
                continue

            result = await _load_single(
                pool, fsm_name, fsm_version, fsm_json_path, workflow_type
            )
            results.append(result)

    return results


async def _load_single(
    pool: asyncpg.Pool,
    fsm_name: str,
    fsm_version: str,
    fsm_json_path: Path,
    workflow_type: WorkflowType,
) -> LoadResult:
    label = f"[{workflow_type}] {fsm_name}/{fsm_version}"
    try:
        fsm_data = json.loads(fsm_json_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.error(f"{label}: failed to read fsm.json — {exc}")
        return LoadResult(
            fsm_name=fsm_name,
            fsm_version=fsm_version,
            fsm_json_path=str(fsm_json_path),
            state_load_ok=False,
            transition_load_ok=False,
            error=str(exc),
        )

    root_node_text = fsm_data.get("key") or fsm_data.get("id") or fsm_name

    load_ok = False
    error: Optional[str] = None

    try:
        await load_fsm_from_json_v2(pool, fsm_name, fsm_version, fsm_data, root_node_text)
        load_ok = True
        logger.info(f"{label}: states and transitions loaded")
    except Exception as exc:
        error = f"load failed: {exc}"
        logger.error(f"{label}: {error}")

    return LoadResult(
        fsm_name=fsm_name,
        fsm_version=fsm_version,
        fsm_json_path=str(fsm_json_path),
        state_load_ok=load_ok,
        transition_load_ok=load_ok,
        error=error,
    )
