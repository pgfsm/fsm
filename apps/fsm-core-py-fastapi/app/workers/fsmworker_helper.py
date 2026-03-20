import asyncio
import logging
from typing import Any, Optional
import asyncpg

from app.db.fsm_helper import select_transitions, perform_microstep

logger = logging.getLogger(__name__)


async def run_action_implementation(
    action_kind: str,
    action: dict,
    actions_module: Any,
    current_context: dict,
    meta: dict,
) -> dict:
    action_name = action.get("type") or action.get("action_type") or action.get("name")
    if actions_module and action_name and callable(getattr(actions_module, action_name, None)):
        try:
            fn = getattr(actions_module, action_name)
            result = await fn(current_context, action.get("params", {}), meta)
            return result if result is not None else current_context
        except Exception:
            logger.exception(f"Error executing {action_kind} action '{action_name}'")
    return current_context


def _eval_cond(cond: Any) -> bool:
    if isinstance(cond, str):
        return cond == "true"
    if isinstance(cond, dict) and cond.get("type"):
        logger.warning(
            f"Guard evaluation for type '{cond['type']}' not implemented; defaulting to False"
        )
        return False
    return False


async def macrostep_v2(
    pool: asyncpg.Pool,
    queue_name: str,
    msg: dict,
    fsm_instance_row: Optional[dict],
    resolved_state_value: Optional[dict],
    fsm_name: str,
    fsm_version: str,
    actions_module: Any = None,
    delay_module: Any = None,
) -> Optional[dict]:
    await asyncio.sleep(0.5)

    event_data = msg.get("message", {})
    event_type = event_data.get("type") if isinstance(event_data, dict) else event_data

    current_context = (fsm_instance_row or {}).get("fsm_instance_context") or {}
    total_schedule_queue_data = (fsm_instance_row or {}).get("total_schedule_queue_data") or []
    total_promise_queue_data = (fsm_instance_row or {}).get("total_promise_queue_data") or []

    remove_schedule_queue_msg_ids: list = []
    remove_promise_queue_msg_ids: list = []
    new_schedule_queue_data: list = []
    new_promise_queue_data: list = []

    selected_transition = None
    if event_type != "initialTransition_event":
        all_nodes = (resolved_state_value or {}).get("all_nodes")
        all_transitions = await select_transitions(
            pool, event_type, all_nodes, fsm_name, fsm_version
        )
        if not all_transitions:
            logger.error("No transitions found for the given FSM name, version, and event.")
            return None
        elif len(all_transitions) == 1:
            selected_transition = all_transitions[0]
        else:
            filtered = [t for t in all_transitions if _eval_cond(t.get("cond"))]
            if len(filtered) != 1:
                logger.error(
                    f"Expected exactly 1 valid transition after guard evaluation, got {len(filtered)}"
                )
                return None
            selected_transition = filtered[0]

    all_nodes = (resolved_state_value or {}).get("all_nodes")
    microstep_result = await perform_microstep(
        pool, selected_transition, event_type, all_nodes, fsm_name, fsm_version
    )

    # XState integration stub — wired up when XState actors are implemented
    next_state: dict = {}

    meta = {"pool": pool, "queue_name": queue_name, "msg": msg}

    for action in microstep_result.get("exit_actions") or []:
        action_type = action.get("type", "")
        if action_type == "xstate.raise":
            remove_schedule_queue_msg_ids.append(action)
        elif action_type == "xstate.invoke":
            remove_promise_queue_msg_ids.append(action)
        else:
            current_context = await run_action_implementation(
                "exit", action, actions_module, current_context, meta
            )

    for action in microstep_result.get("transition_actions") or []:
        current_context = await run_action_implementation(
            "transition", action, actions_module, current_context, meta
        )

    for action in microstep_result.get("entry_actions") or []:
        action_type = action.get("type", "")
        if action_type == "xstate.raise":
            delay = action.get("params", {}).get("delay", 5_000_000)
            new_schedule_queue_data.append({**action, "delay": delay})
        elif action_type == "xstate.invoke":
            new_promise_queue_data.append({**action})
        else:
            current_context = await run_action_implementation(
                "entry", action, actions_module, current_context, meta
            )

    # Remove the current event from scheduled removes if it matches
    remove_schedule_queue_msg_ids = [
        item for item in remove_schedule_queue_msg_ids if item != event_type
    ]

    return {
        "remove_from_current_fsm_instance_queue_id": queue_name,
        "remove_current_queue_msg_id": msg.get("msg_id"),
        "remove_schedule_queue_msg_ids": remove_schedule_queue_msg_ids,
        "remove_promise_queue_msg_ids": remove_promise_queue_msg_ids,
        "new_schedule_queue_data": new_schedule_queue_data,
        "new_promise_queue_data": new_promise_queue_data,
        "total_schedule_queue_data": total_schedule_queue_data,
        "total_promise_queue_data": total_promise_queue_data,
        "fsm_instance_data_save_fsm_status": "active",
        "fsm_instance_data_save_fsm_state": (
            (microstep_result.get("updated_state_value") or {}).get("machine")
        ),
        "fsm_instance_data_save_fsm_context": next_state.get("context") or current_context,
        "fsm_instance_data_save_fsm_xstate_state": next_state,
        # Passed through for logging/debugging; not used by archive fn
        "exit_actions": microstep_result.get("exit_actions") or [],
        "transition_actions": microstep_result.get("transition_actions") or [],
        "entry_actions": microstep_result.get("entry_actions") or [],
    }
