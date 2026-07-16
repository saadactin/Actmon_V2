import json
from typing import List, Optional

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.mysql import mysql_log_service

router = APIRouter(
    prefix="/api/v1/connections/mysql",
    tags=["MySQL Error Logs"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── Request models ────────────────────────────────────────────────────────────

class ErrorPayload(BaseModel):
    message: str


class SelfHealPayload(BaseModel):
    error_message: str


class AnalyzeGroqPayload(BaseModel):
    logs:     List[dict]        = []
    log_path: Optional[str]     = None
    source:   Optional[str]     = None
    host:     Optional[str]     = None
    database: Optional[str]     = None


class SelfHealStreamPayload(BaseModel):
    commands: List[str] = []


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/{conn_id}/error-logs")
def get_error_logs(conn_id: int, db: Session = Depends(get_db)):
    return mysql_log_service.get_error_logs(conn_id, db)


@router.post("/{conn_id}/analyze-error")
def analyze_error(conn_id: int, payload: ErrorPayload, db: Session = Depends(get_db)):
    return mysql_log_service.analyze_error_with_ai(conn_id, payload.message, db)


@router.post("/{conn_id}/self-heal")
def self_heal_error(conn_id: int, payload: SelfHealPayload, db: Session = Depends(get_db)):
    return mysql_log_service.run_self_heal(conn_id, payload.error_message, db)


@router.get("/{conn_id}/self-heal-history")
def get_self_heal_history(conn_id: int):
    return mysql_log_service.get_self_heal_history_data(conn_id)


@router.post("/{conn_id}/analyze-groq")
def analyze_groq_errors(conn_id: int, payload: AnalyzeGroqPayload, db: Session = Depends(get_db)):
    return mysql_log_service.analyze_with_groq(
        conn_id, payload.logs, payload.log_path,
        payload.source, payload.host, payload.database, db,
    )


@router.post("/{conn_id}/self-heal-stream")
async def self_heal_stream(conn_id: int, payload: SelfHealStreamPayload, db: Session = Depends(get_db)):
    from app.models.connection_model import ConnectionMaster
    from fastapi import HTTPException

    connection = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not connection:
        raise HTTPException(404, "Connection not found")

    async def generate():
        async for evt in mysql_log_service.create_self_heal_stream(connection, payload.commands):
            yield f"data: {json.dumps(evt)}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":    "no-cache",
            "X-Accel-Buffering": "no",
            "Connection":       "keep-alive",
        },
    )
