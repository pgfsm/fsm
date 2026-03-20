from typing import Any, Optional
from pydantic import BaseModel, Field


class FsmWorkerCreateRequest(BaseModel):
    queue: str = Field(..., description="The fsm_instance_id to start a worker for")


class DataResponse(BaseModel):
    data: Optional[Any] = None


class ErrorResponse(BaseModel):
    error: str
