import json
from typing import Any, Optional


def to_jsonb_param(value: Any) -> Optional[str]:
    """
    Serialize a Python value to a JSON string for use as a ::jsonb parameter.
    Returns None for None/undefined values — mirrors toJsonbParam() in pg-utils.ts.
    """
    if value is None:
        return None
    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return None
