"""
generate_fsm_plugin.py
~~~~~~~~~~~~~~~~~~~~~~
Generates Python stub files for actions, guards, delays, and actors based on
the symbols referenced in ``fsm.json``. Mirrors generateFsmPluginFromFolders()
in generateFsmPlugin.ts — Python output only (no TypeScript stubs).

Generates under each version folder::

    <version>/python/actions/index.py
    <version>/python/guards/index.py
    <version>/python/delays/index.py
    <version>/python/actors/index.py
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .util import is_version_folder_name
from ._fsm_extractor import extract_symbols

logger = logging.getLogger(__name__)


@dataclass
class GenerateResult:
    fsm_name: str
    fsm_version: str
    files_written: list[str] = field(default_factory=list)
    files_skipped: list[str] = field(default_factory=list)  # already exist, not overwritten
    error: Optional[str] = None


def generate_fsm_plugin_from_folders(
    folder_path: str,
    workflow_type: str,
    skip_dirs: Optional[list[str]] = None,
    overwrite: bool = False,
) -> list[GenerateResult]:
    """
    Walk versioned FSM directories and generate Python stub files.

    Args:
        folder_path:   Root directory with ``<fsm_name>/<version>/`` layout.
        workflow_type: Label for log messages.
        skip_dirs:     FSM name directories to skip.
        overwrite:     If False (default), skip files that already exist so
                       hand-written implementations are never clobbered.

    Returns:
        List of :class:`GenerateResult`, one per version processed.
    """
    skip_dirs = skip_dirs or []
    base = Path(folder_path)
    results: list[GenerateResult] = []

    if not base.is_dir():
        logger.error(f"folder_path not found: {folder_path}")
        return results

    for fsm_dir in sorted(base.iterdir()):
        if not fsm_dir.is_dir() or fsm_dir.name in skip_dirs:
            continue
        for version_dir in sorted(fsm_dir.iterdir()):
            if not version_dir.is_dir() or not is_version_folder_name(version_dir.name):
                continue
            result = _generate_version(
                fsm_dir.name, version_dir, workflow_type, overwrite
            )
            results.append(result)

    return results


# ── internals ────────────────────────────────────────────────────────────────

def _generate_version(
    fsm_name: str,
    version_dir: Path,
    workflow_type: str,
    overwrite: bool,
) -> GenerateResult:
    fsm_version = version_dir.name
    result = GenerateResult(fsm_name=fsm_name, fsm_version=fsm_version)
    label = f"[{workflow_type}] {fsm_name}/{fsm_version}"

    fsm_json_path = version_dir / "fsm.json"
    if not fsm_json_path.exists():
        result.error = "fsm.json not found"
        logger.warning(f"{label}: fsm.json not found, skipping")
        return result

    try:
        fsm_data = json.loads(fsm_json_path.read_text(encoding="utf-8"))
    except Exception as exc:
        result.error = str(exc)
        logger.error(f"{label}: failed to parse fsm.json — {exc}")
        return result

    symbols = extract_symbols(fsm_data)
    python_dir = version_dir / "python"

    actor_names = [a["src"] for a in symbols.actors if a.get("fsmType") == "promise"]

    specs = [
        ("actions", symbols.actions, _action_stub),
        ("guards",  symbols.guards,  _guard_stub),
        ("delays",  symbols.delays,  _delay_stub),
        ("actors",  actor_names,     _actor_stub),
    ]

    for kind, names, stub_fn in specs:
        out_path = python_dir / kind / "index.py"
        out_path.parent.mkdir(parents=True, exist_ok=True)

        if out_path.exists() and not overwrite:
            result.files_skipped.append(str(out_path))
            logger.debug(f"{label}: {kind}/index.py already exists, skipping")
            continue

        content = _build_module(kind, names, stub_fn)
        out_path.write_text(content, encoding="utf-8")
        result.files_written.append(str(out_path))
        logger.info(f"{label}: wrote {out_path}")

    return result


def _build_module(kind: str, names: list[str], stub_fn) -> str:
    header = f'"""\n{kind}/index.py — auto-generated stubs. Implement each function.\n"""\n\n'
    if not names:
        return header + "# No {kind} functions required by this FSM.\n"
    return header + "\n\n".join(stub_fn(n) for n in names) + "\n"


def _action_stub(name: str) -> str:
    return (
        f"async def {name}(context: dict, params: dict, meta: dict) -> dict:\n"
        f'    """Action: {name}"""\n'
        f"    raise NotImplementedError(\"{name} is not implemented\")\n"
        f"    return context"
    )


def _guard_stub(name: str) -> str:
    return (
        f"def {name}(context: dict, event: dict) -> bool:\n"
        f'    """Guard: {name}"""\n'
        f"    raise NotImplementedError(\"{name} is not implemented\")\n"
        f"    return False"
    )


def _delay_stub(name: str) -> str:
    return (
        f"def {name}(context: dict, event: dict) -> int:\n"
        f'    """Delay (ms): {name}"""\n'
        f"    raise NotImplementedError(\"{name} is not implemented\")\n"
        f"    return 0"
    )


def _actor_stub(name: str) -> str:
    return (
        f"async def {name}(context: dict, event: dict) -> dict:\n"
        f'    """Actor/promise: {name}"""\n'
        f"    raise NotImplementedError(\"{name} is not implemented\")\n"
        f"    return {{}}"
    )
