from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(tags=["Index"])


class IndexResponse(BaseModel):
    message: str


@router.get("/", response_model=IndexResponse)
async def index():
    return {"message": "Tasks API"}
