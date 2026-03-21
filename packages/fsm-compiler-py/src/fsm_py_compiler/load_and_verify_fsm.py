"""
load_and_verify_fsm.py
~~~~~~~~~~~~~~~~~~~~~~
Orchestrates FSM database loading + plugin validation in one pass, per version.

For each <fsm_name>/<version>/fsm.json found:
  1. Call ``load_fsm_from_json_v2`` to load into the database.
  2. If load succeeded, call ``_validate_version`` to check plugin modules.
  3. Log combined status:

     - ``✓ loaded + verified``    — DB load ok AND plugin modules complete.
     - ``~ loaded, not verified`` — DB load ok BUT plugin validation failed.
     - ``✗ not loaded``           — DB load failed; plugin validation skipped.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import asyncpg

from fsm_core_db import load_fsm_from_json_v2

from .load_fsm_json import LoadResult
from .util import is_version_folder_name
from .validate_fsm_plugin import (
    VersionValidationResult,
    _bundled_schema_path,
    _load_schema,
    _validate_version,
)

logger = logging.getLogger(__name__)


@dataclass
class LoadAndVerifyResult:
    """Combined outcome for one FSM version: DB load + plugin validation."""

    fsm_name: str
    fsm_version: str
    load_result: LoadResult
    verify_result: Optional[VersionValidationResult]

    @property
    def loaded(self) -> bool:
        return self.load_result.state_load_ok and self.load_result.transition_load_ok

    @property
    def verified(self) -> bool:
        return self.verify_result is not None and self.verify_result.valid


async def load_and_verify_fsm_from_folders(
    pool: asyncpg.Pool,
    folder_path: str,
    workflow_type: str,
    skip_dirs: Optional[list[str]] = None,
    schema_path: Optional[str] = None,
) -> list[LoadAndVerifyResult]:
    """
    Walk ``folder_path`` for versioned FSM directories. For each version:
      1. Load ``fsm.json`` into the database via ``load_fsm_from_json_v2``.
      2. If load succeeded, run plugin validation via ``_validate_version``.

    Args:
        pool:          asyncpg connection pool (from fsm_core_db.create_pool).
        folder_path:   Root directory with ``<fsm_name>/<version>/fsm.json`` layout.
        workflow_type: Label for log messages (e.g. "fsm", "sharedFSM").
        skip_dirs:     FSM name directories to skip entirely.
        schema_path:   Path to ``fsm.machine.schema.json``. Falls back to bundled copy.

    Returns:
        List of :class:`LoadAndVerifyResult`, one per version processed.
    """
    skip_dirs = skip_dirs or []
    base = Path(folder_path)
    schema = _load_schema(schema_path or str(_bundled_schema_path()))
    results: list[LoadAndVerifyResult] = []

    if not base.is_dir():
        logger.error(f"folder_path does not exist or is not a directory: {folder_path}")
        return results

    for fsm_dir in sorted(base.iterdir()):
        if not fsm_dir.is_dir() or fsm_dir.name in skip_dirs:
            continue
        for version_dir in sorted(fsm_dir.iterdir()):
            if not version_dir.is_dir() or not is_version_folder_name(version_dir.name):
                continue
            fsm_json_path = version_dir / "fsm.json"
            if not fsm_json_path.exists():
                logger.warning(
                    f"[{workflow_type}] {fsm_dir.name}/{version_dir.name}: fsm.json not found, skipping"
                )
                continue
            entry = await _load_and_verify_single(
                pool, fsm_dir.name, version_dir.name, fsm_json_path, version_dir, workflow_type, schema
            )
            results.append(entry)

    return results


async def _load_and_verify_single(
    pool: asyncpg.Pool,
    fsm_name: str,
    fsm_version: str,
    fsm_json_path: Path,
    version_dir: Path,
    workflow_type: str,
    schema: Optional[dict],
) -> LoadAndVerifyResult:
    label = f"[{workflow_type}] {fsm_name}/{fsm_version}"

    # ── 1. Parse fsm.json ────────────────────────────────────────────────────
    try:
        fsm_data = json.loads(fsm_json_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.error(f"{label}: ✗ not loaded — {exc}")
        lr = LoadResult(
            fsm_name=fsm_name,
            fsm_version=fsm_version,
            fsm_json_path=str(fsm_json_path),
            state_load_ok=False,
            transition_load_ok=False,
            error=str(exc),
        )
        return LoadAndVerifyResult(fsm_name=fsm_name, fsm_version=fsm_version, load_result=lr, verify_result=None)

    root_node_text: Optional[str] = fsm_data.get("key") or fsm_data.get("id") or fsm_name

    # ── 2. Load into database ────────────────────────────────────────────────
    load_ok = False
    load_error: Optional[str] = None
    try:
        await load_fsm_from_json_v2(pool, fsm_name, fsm_version, fsm_data, root_node_text)
        load_ok = True
    except Exception as exc:
        load_error = str(exc)
        logger.error(f"{label}: ✗ not loaded — {exc}")

    lr = LoadResult(
        fsm_name=fsm_name,
        fsm_version=fsm_version,
        fsm_json_path=str(fsm_json_path),
        state_load_ok=load_ok,
        transition_load_ok=load_ok,
        error=load_error,
    )

    if not load_ok:
        return LoadAndVerifyResult(fsm_name=fsm_name, fsm_version=fsm_version, load_result=lr, verify_result=None)

    # ── 3. Validate plugin modules (only if DB load succeeded) ───────────────
    vr = _validate_version(fsm_name, version_dir, schema, workflow_type)

    _log_combined_result(label, vr)
    return LoadAndVerifyResult(fsm_name=fsm_name, fsm_version=fsm_version, load_result=lr, verify_result=vr)


def _log_combined_result(label: str, vr: VersionValidationResult) -> None:
    if vr.valid:
        logger.info(f"{label}: ✓ loaded + verified")
        return

    logger.warning(f"{label}: ~ loaded, not verified")
    for err in vr.schema_errors:
        logger.warning(f"{label}  schema: {err}")
    for m in vr.modules:
        if m.missing:
            logger.warning(f"{label}  {m.module_kind}: missing implementations: {m.missing}")
