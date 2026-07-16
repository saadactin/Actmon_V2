import io
from typing import Optional, List, Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.mysql import mysql_slow_query_service

router = APIRouter(
    prefix="/api/v1/connections/mysql",
    tags=["MySQL Slow Queries"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── Request models ────────────────────────────────────────────────────────────

class SSHConfigRequest(BaseModel):
    ssh_host:     Optional[str] = None
    ssh_port:     Optional[int] = 22
    ssh_user:     str
    ssh_password: str


class SlowQueryGroqRequest(BaseModel):
    sql_text:       str
    db_name:        Optional[str]   = None
    count_calls:    Optional[int]   = 0
    avg_exec_sec:   Optional[float] = 0.0
    max_exec_sec:   Optional[float] = 0.0
    total_exec_sec: Optional[float] = 0.0
    rows_examined:  Optional[int]   = 0
    rows_returned:  Optional[int]   = 0
    no_index_count: Optional[int]   = 0
    last_seen:      Optional[str]   = None
    explain_rows:   Optional[List[Any]] = []


class ExplainAnalysisRequest(BaseModel):
    sql_text: str
    db_name:  Optional[str] = None


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/{conn_id}/slow-queries")
def get_slow_queries(conn_id: int, live: bool = Query(False), db: Session = Depends(get_db)):
    return mysql_slow_query_service.get_slow_queries(conn_id, db, live=live)


@router.get("/{conn_id}/ssh-config")
def get_ssh_config(conn_id: int, db: Session = Depends(get_db)):
    return mysql_slow_query_service.get_ssh_config_data(conn_id, db)


@router.put("/{conn_id}/ssh-config")
def save_ssh_config(conn_id: int, payload: SSHConfigRequest, db: Session = Depends(get_db)):
    return mysql_slow_query_service.save_ssh_config_data(
        conn_id, payload.ssh_host, payload.ssh_port, payload.ssh_user, payload.ssh_password, db
    )


@router.post("/{conn_id}/slow-queries/analyze-groq")
def analyze_slow_query_groq(conn_id: int, payload: SlowQueryGroqRequest, db: Session = Depends(get_db)):
    return mysql_slow_query_service.analyze_slow_query_with_groq(conn_id, payload.dict(), db)


@router.post("/{conn_id}/slow-queries/explain-analyze")
def explain_and_analyze(conn_id: int, payload: ExplainAnalysisRequest, db: Session = Depends(get_db)):
    return mysql_slow_query_service.explain_and_analyze_query(
        conn_id, payload.sql_text, payload.db_name, db
    )


@router.get("/{conn_id}/slow-queries/export")
def export_slow_queries_report(
    conn_id: int,
    period: str = Query("daily", pattern="^(hourly|daily|weekly|all)$"),
    db: Session = Depends(get_db),
):
    result = mysql_slow_query_service.build_export_csv(conn_id, period, db)
    return StreamingResponse(
        io.BytesIO(result["csv_bytes"]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={result['filename']}"},
    )
