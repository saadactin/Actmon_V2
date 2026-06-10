from fastapi import APIRouter
from pydantic import BaseModel

from services.mysql_ai_analysis import (
    analyze_mysql_error
)

router = APIRouter()

class ErrorPayload(BaseModel):
    message: str


@router.post("/mysql/{id}/analyze-error")
async def analyze_error(
    id: int,
    payload: ErrorPayload
):

    result = analyze_mysql_error(
        payload.message
    )

    return {
        "status": "success",
        "analysis": result
    }