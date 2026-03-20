"""
_fsm_extractor.py
~~~~~~~~~~~~~~~~~
Walks an fsm.json structure and collects all action, guard, delay, and actor
names referenced anywhere in the machine. Used by both validate_fsm_plugin and
generate_fsm_plugin. Mirrors getActionsAndGuardsFromFsmJson() in generateFsmPlugin.ts.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any


@dataclass
class FsmSymbols:
    actions: list[str] = field(default_factory=list)
    guards: list[str] = field(default_factory=list)
    delays: list[str] = field(default_factory=list)
    actors: list[dict] = field(default_factory=list)  # {src, fsmType?, fsmVersion?}

    def deduplicated(self) -> "FsmSymbols":
        seen_actors: dict[str, dict] = {}
        for a in self.actors:
            seen_actors.setdefault(a["src"], a)
        return FsmSymbols(
            actions=sorted(set(self.actions)),
            guards=sorted(set(self.guards)),
            delays=sorted(set(self.delays)),
            actors=list(seen_actors.values()),
        )


def extract_symbols(fsm_data: Any) -> FsmSymbols:
    """
    Recursively extract all action, guard, delay, and actor names from an fsm.json dict.
    """
    result = FsmSymbols()
    _walk(fsm_data, result)
    return result.deduplicated()


def _action_name(action: Any) -> str | None:
    if isinstance(action, str):
        return action
    if isinstance(action, dict):
        return action.get("type") or action.get("name")
    return None


def _walk(node: Any, result: FsmSymbols) -> None:
    if not isinstance(node, dict):
        return

    # entry / exit actions
    for key in ("entry", "exit"):
        for action in node.get(key) or []:
            name = _action_name(action)
            if name and not name.startswith("xstate."):
                result.actions.append(name)

    # invoke actors
    for invoke in node.get("invoke") or []:
        if isinstance(invoke, dict) and invoke.get("src"):
            result.actors.append({
                "src": invoke["src"],
                "fsmType": invoke.get("fsmType"),
                "fsmVersion": invoke.get("fsmVersion"),
            })

    # transitions via `on` map
    for transitions in (node.get("on") or {}).values():
        for t in (transitions if isinstance(transitions, list) else [transitions]):
            _walk_transition(t, result)

    # transitions array form
    for t in node.get("transitions") or []:
        _walk_transition(t, result)

    # initial transition
    if isinstance(node.get("initial"), dict):
        _walk_transition(node["initial"], result)

    # recurse into nested states
    for child in (node.get("states") or {}).values():
        _walk(child, result)


def _walk_transition(t: Any, result: FsmSymbols) -> None:
    if not isinstance(t, dict):
        return

    for action in t.get("actions") or []:
        name = _action_name(action)
        if name and not name.startswith("xstate."):
            result.actions.append(name)

    guard = t.get("guard")
    if isinstance(guard, str) and guard:
        result.guards.append(guard)
    elif isinstance(guard, dict) and guard.get("type"):
        result.guards.append(guard["type"])

    delay = t.get("delay")
    if isinstance(delay, str) and delay:
        result.delays.append(delay)
