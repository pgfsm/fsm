from typing import Any, Dict, Optional
from pydantic import BaseModel, Field


class FsmCreateRequest(BaseModel):
    fsm_name: str = Field(..., description="The name of the FSM to start")
    fsm_version: str = Field(..., description="The version of the FSM to start")


class FsmSendRequest(BaseModel):
    fsm_instance_id: str = Field(..., description="Target FSM instance ID")
    event_data: Dict[str, Any] = Field(
        ..., description="Event object; must contain at minimum a 'type' field"
    )


class DataResponse(BaseModel):
    data: Optional[Any] = None


class ErrorResponse(BaseModel):
    error: str
