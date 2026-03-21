"""
load_and_verify_fsm.py
~~~~~~~~~~~~~~~~~~~~~~
Orchestrates FSM database loading + plugin validation in one pass.

Steps:
  1. Load FSM JSON into the database via ``load_fsm_json_from_folders``.
  2. Run plugin validation via ``validate_fsm_plugin_from_folders``.
  3. Log a combined status per FSM/version:

     - ``✓ loaded + verified``    — DB load succeeded AND plugin modules are complete.
     - ``~ loaded, not verified`` — DB load succeeded but plugin validation failed/missing.
     - ``✗ not loaded``           — DB load failed; plugin validation skipped.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

import asyncpg

from .load_fsm_json import load_fsm_json_from_folders, LoadResult
from .validate_fsm_plugin import validate_fsm_plugin_from_folders, VersionValidationResult

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
    Load FSM definitions into the database then validate their plugin modules.

    Args:
        pool:          asyncpg connection pool (from fsm_core_db.create_pool).
        folder_path:   Root directory with ``<fsm_name>/<version>/fsm.json`` layout.
        workflow_type: Label for log messages (e.g. "fsm", "sharedFSM").
        skip_dirs:     FSM name directories to skip entirely.
        schema_path:   Path to ``fsm.machine.schema.json`` for plugin validation.
                       Falls back to the copy bundled inside this package.

    Returns:
        List of :class:`LoadAndVerifyResult`, one per version processed.
    """
    # 1. Load FSM JSON into the database
    load_results = await load_fsm_json_from_folders(pool, folder_path, workflow_type, skip_dirs)

    # 2. Validate plugin modules (synchronous, walks the same folder tree)
    verify_results = validate_fsm_plugin_from_folders(
        folder_path, workflow_type, skip_dirs, schema_path
    )

    # Index verify results by (fsm_name, fsm_version) for O(1) lookup
    verify_index: dict[tuple[str, str], VersionValidationResult] = {
        (r.fsm_name, r.fsm_version): r for r in verify_results
    }

    combined: list[LoadAndVerifyResult] = []
    for lr in load_results:
        vr = verify_index.get((lr.fsm_name, lr.fsm_version))
        entry = LoadAndVerifyResult(
            fsm_name=lr.fsm_name,
            fsm_version=lr.fsm_version,
            load_result=lr,
            verify_result=vr,
        )
        combined.append(entry)
        _log_combined(entry, workflow_type)

    return combined


def _log_combined(result: LoadAndVerifyResult, workflow_type: str) -> None:
    label = f"[{workflow_type}] {result.fsm_name}/{result.fsm_version}"

    if result.loaded and result.verified:
        logger.info(f"{label}: ✓ loaded + verified")
        return

    if result.loaded:
        logger.warning(f"{label}: ~ loaded, not verified")
        vr = result.verify_result
        if vr is None:
            logger.warning(f"{label}  plugin validation did not run")
            return
        for err in vr.schema_errors:
            logger.warning(f"{label}  schema: {err}")
        for m in vr.modules:
            if m.missing:
                logger.warning(f"{label}  {m.module_kind}: missing implementations: {m.missing}")
        return

    lr = result.load_result
    logger.error(f"{label}: ✗ not loaded — {lr.error or 'unknown error'}")
