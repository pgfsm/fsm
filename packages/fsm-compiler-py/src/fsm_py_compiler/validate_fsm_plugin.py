"""
validate_fsm_plugin.py
~~~~~~~~~~~~~~~~~~~~~~
Validates that Python plugin modules (actions, guards, delays, actors) implement
every function referenced in ``fsm.json``. Also validates ``fsm.json`` against the
JSON schema. Mirrors validateFsmPluginLoadFromFolders() in validateFsmPluginLoad.ts.

Expected layout per version folder::

    <version>/
        fsm.json
        python/
            actions/index.py
            guards/index.py
            delays/index.py
            actors/index.py
"""

from __future__ import annotations

import importlib.util
import json
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Optional

import importlib.resources

import jsonschema

from .util import is_version_folder_name
from ._fsm_extractor import extract_symbols, FsmSymbols

logger = logging.getLogger(__name__)


def _bundled_schema_path() -> Path:
    """Return path to the fsm.machine.schema.json bundled inside this package."""
    try:
        ref = importlib.resources.files("fsm_py_compiler").joinpath("fsm.machine.schema.json")
        return Path(str(ref))
    except Exception:
        return Path(__file__).parent / "fsm.machine.schema.json"


@dataclass
class ModuleValidationResult:
    """Validation outcome for a single plugin module (e.g. actions/index.py)."""
    module_kind: str          # "actions" | "guards" | "delays" | "actors"
    file_path: str
    module_found: bool
    required: list[str]       # function names required by fsm.json
    implemented: list[str]    # names that ARE callable in the module
    missing: list[str]        # required but not callable
    extra: list[str]          # callable but not required (informational)

    @property
    def valid(self) -> bool:
        return self.module_found and len(self.missing) == 0


@dataclass
class VersionValidationResult:
    """Full validation result for one FSM version folder."""
    fsm_name: str
    fsm_version: str
    fsm_json_present: bool = False
    fsm_json_follows_schema: bool = False
    schema_errors: list[str] = field(default_factory=list)
    modules: list[ModuleValidationResult] = field(default_factory=list)
    required_child_actors: list[dict] = field(default_factory=list)

    @property
    def valid(self) -> bool:
        return (
            self.fsm_json_present
            and self.fsm_json_follows_schema
            and all(m.valid for m in self.modules)
        )


def validate_fsm_plugin_from_folders(
    folder_path: str,
    workflow_type: str,
    skip_dirs: Optional[list[str]] = None,
    schema_path: Optional[str] = None,
) -> list[VersionValidationResult]:
    """
    Walk ``folder_path`` for versioned FSM directories and validate each one.

    Args:
        folder_path:   Root directory with ``<fsm_name>/<version>/`` layout.
        workflow_type: Label used in log messages (e.g. "fsm", "sharedFSM").
        skip_dirs:     FSM name directories to skip.
        schema_path:   Path to ``fsm.machine.schema.json``. Falls back to the
                       copy under ``packages/database-src/``.

    Returns:
        List of :class:`VersionValidationResult`, one per version processed.
    """
    skip_dirs = skip_dirs or []
    base = Path(folder_path)
    results: list[VersionValidationResult] = []

    schema = _load_schema(schema_path or str(_bundled_schema_path()))

    if not base.is_dir():
        logger.error(f"folder_path not found: {folder_path}")
        return results

    for fsm_dir in sorted(base.iterdir()):
        if not fsm_dir.is_dir() or fsm_dir.name in skip_dirs:
            continue
        for version_dir in sorted(fsm_dir.iterdir()):
            if not version_dir.is_dir() or not is_version_folder_name(version_dir.name):
                continue
            result = _validate_version(
                fsm_dir.name, version_dir, schema, workflow_type
            )
            results.append(result)
            _log_result(result, workflow_type)

    return results


# ── internals ────────────────────────────────────────────────────────────────

def _load_schema(schema_path: Optional[str]) -> Optional[dict]:
    path = Path(schema_path) if schema_path else _DEFAULT_SCHEMA_PATH
    if not path.exists():
        logger.warning(f"Schema file not found at {path}; schema validation will be skipped")
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning(f"Could not load schema: {exc}; schema validation will be skipped")
        return None


def _validate_version(
    fsm_name: str,
    version_dir: Path,
    schema: Optional[dict],
    workflow_type: str,
) -> VersionValidationResult:
    fsm_version = version_dir.name
    result = VersionValidationResult(fsm_name=fsm_name, fsm_version=fsm_version)

    # ── 1. Load fsm.json ──────────────────────────────────────────────────────
    fsm_json_path = version_dir / "fsm.json"
    if not fsm_json_path.exists():
        return result

    result.fsm_json_present = True
    try:
        fsm_data = json.loads(fsm_json_path.read_text(encoding="utf-8"))
    except Exception as exc:
        result.schema_errors.append(f"JSON parse error: {exc}")
        return result

    # ── 2. Validate against schema ────────────────────────────────────────────
    if schema:
        errors = _validate_schema(fsm_data, schema)
        if errors:
            result.schema_errors = errors
        else:
            result.fsm_json_follows_schema = True
    else:
        result.fsm_json_follows_schema = True  # no schema available, skip

    # ── 3. Extract required symbols ───────────────────────────────────────────
    symbols = extract_symbols(fsm_data)

    # child actors that are childFSM/sharedFSM (not promise)
    result.required_child_actors = [
        a for a in symbols.actors
        if a.get("fsmType") in ("childFSM", "sharedFSM")
    ]

    # ── 4. Validate Python plugin modules ─────────────────────────────────────
    python_dir = version_dir / "python"
    module_specs = [
        ("actions", symbols.actions),
        ("guards",  symbols.guards),
        ("delays",  symbols.delays),
        ("actors",  [a["src"] for a in symbols.actors if a.get("fsmType") == "promise"]),
    ]
    for kind, required in module_specs:
        mod_result = _validate_module(python_dir / kind / "index.py", kind, required)
        result.modules.append(mod_result)

    return result


def _validate_schema(fsm_data: dict, schema: dict) -> list[str]:
    try:
        validator = jsonschema.Draft7Validator(schema)
        return [e.message for e in validator.iter_errors(fsm_data)]
    except Exception as exc:
        return [f"Validation exception: {exc}"]


def _validate_module(
    module_path: Path, kind: str, required: list[str]
) -> ModuleValidationResult:
    base = ModuleValidationResult(
        module_kind=kind,
        file_path=str(module_path),
        module_found=False,
        required=required,
        implemented=[],
        missing=[],
        extra=[],
    )

    if not module_path.exists():
        base.missing = list(required)
        return base

    mod = _import_module_from_path(module_path, f"_fsm_plugin_{kind}_{id(module_path)}")
    if mod is None:
        base.missing = list(required)
        return base

    base.module_found = True

    # collect all callable public names in the module
    callable_names = {
        name for name in dir(mod)
        if not name.startswith("_") and callable(getattr(mod, name, None))
    }

    base.implemented = [n for n in required if n in callable_names]
    base.missing = [n for n in required if n not in callable_names]
    base.extra = sorted(callable_names - set(required))
    return base


def _import_module_from_path(path: Path, module_name: str) -> Optional[ModuleType]:
    try:
        spec = importlib.util.spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            return None
        mod = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = mod
        spec.loader.exec_module(mod)  # type: ignore[attr-defined]
        return mod
    except Exception as exc:
        logger.warning(f"Could not import {path}: {exc}")
        return None


def _log_result(result: VersionValidationResult, workflow_type: str) -> None:
    label = f"[{workflow_type}] {result.fsm_name}/{result.fsm_version}"
    status = "✓ valid" if result.valid else "✗ invalid"
    logger.info(f"{label}: {status}")
    for err in result.schema_errors:
        logger.warning(f"{label} schema error: {err}")
    for m in result.modules:
        if m.missing:
            logger.warning(
                f"{label} {m.module_kind}: missing implementations: {m.missing}"
            )
