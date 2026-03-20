from typing import Any, Optional
from pydantic import BaseModel, Field


class FsmPromiseCreateRequest(BaseModel):
    promise_name: str = Field(..., description="The name of the promise queue to start")
    promise_version: str = Field(..., description="The version of the promise")


class DataResponse(BaseModel):
    data: Optional[Any] = None


class ErrorResponse(BaseModel):
    error: str
