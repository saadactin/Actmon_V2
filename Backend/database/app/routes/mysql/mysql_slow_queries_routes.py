import io
from typing import Optional, List, Any, Dict

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.mysql import mysql_slow_query_service
from app.services.mysql import mysql_slow_query_analysis_service as analysis_service

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


class AnalyzeFullRequest(BaseModel):
    sql_text: str
    db_name:  Optional[str] = None
    mode:     str = "estimate"  # "estimate" (default, safe) | "analyze" (EXPLAIN ANALYZE — gated, see _is_safe_to_execute)
    rows_examined: Optional[int] = 0
    rows_returned: Optional[int] = 0
    count_calls:   Optional[int] = 0
    avg_exec_ms:   Optional[float] = 0.0
    total_exec_ms: Optional[float] = 0.0


class SlowQueryContextGroqRequest(BaseModel):
    sql_text:       str
    db_name:        Optional[str]   = None
    count_calls:    Optional[int]   = 0
    avg_exec_sec:   Optional[float] = 0.0
    max_exec_sec:   Optional[float] = 0.0
    total_exec_sec: Optional[float] = 0.0
    rows_examined:  Optional[int]   = 0
    rows_returned:  Optional[int]   = 0
    analysis:       Dict[str, Any]  = {}   # the analyze-full response — explain/tables/index_coverage/duplicate_indexes/diagnosis


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/{conn_id}/slow-queries")
def get_slow_queries(
    conn_id: int,
    live: bool = Query(False),
    db_name: Optional[str] = Query(None, description="Filter to one database/schema"),
    min_avg_ms: Optional[float] = Query(None, description="Only queries averaging at least this many ms"),
    search: Optional[str] = Query(None, description="Substring search over query text"),
    severity: Optional[str] = Query(None, pattern="^(?i)(all|critical|high|medium|low)$"),
    date_from: Optional[str] = Query(None, description="ISO date/datetime — only entries at/after this"),
    date_to: Optional[str] = Query(None, description="ISO date/datetime — only entries at/before this"),
    sort_by: Optional[str] = Query(None, pattern="^(avg|total|count|rows_examined|rows_returned|max|last_seen)$"),
    sort_dir: str = Query("desc", pattern="^(asc|desc)$"),
    page: int = Query(1, ge=1),
    # Default 200 matches the collector's own existing cap — passing no
    # filters/paging at all behaves EXACTLY like the old unfiltered endpoint.
    page_size: int = Query(200, ge=1, le=500),
    db: Session = Depends(get_db),
):
    return mysql_slow_query_service.list_slow_queries_filtered(
        conn_id, db, live=live, database_name=db_name, min_avg_ms=min_avg_ms, search=search,
        severity=severity, date_from=date_from, date_to=date_to,
        sort_by=sort_by, sort_dir=sort_dir, page=page, page_size=page_size,
    )


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


@router.post("/{conn_id}/slow-queries/analyze-full")
def analyze_query_full(conn_id: int, payload: AnalyzeFullRequest, db: Session = Depends(get_db)):
    """The fast, deterministic half of the Analyze Query workspace — EXPLAIN
    FORMAT=JSON (or, opt-in and safety-gated, EXPLAIN ANALYZE), the query's
    OWN tables' real metadata/indexes, duplicate-index detection, query-vs-
    index coverage validation, and rule-based diagnosis. Read-only; never
    creates/drops anything. No Groq call here — see /analyze-context for that,
    triggered separately so opening a query never blocks on an LLM call."""
    metrics = {
        "rows_examined": payload.rows_examined, "rows_returned": payload.rows_returned,
        "count_calls": payload.count_calls, "avg_exec_ms": payload.avg_exec_ms, "total_exec_ms": payload.total_exec_ms,
    }
    return analysis_service.analyze_query_full(
        conn_id, payload.sql_text, payload.db_name, metrics, db, mode=payload.mode
    )


@router.post("/{conn_id}/slow-queries/analyze-context")
def analyze_slow_query_context(conn_id: int, payload: SlowQueryContextGroqRequest, db: Session = Depends(get_db)):
    """The AI half of the Analyze Query workspace — same Groq call convention
    as /analyze-groq, but sent the FULL evidence bundle from /analyze-full
    (explain plan, real table/index metadata, coverage check, diagnosis) so
    Groq reasons from actual database facts rather than the query text alone.
    /analyze-groq is untouched and still backs the simpler Overview/Explorer
    "AI Analysis" tabs, which never gather this context."""
    body = payload.dict()
    analysis = body.pop("analysis", {}) or {}
    return mysql_slow_query_service.analyze_slow_query_with_context(conn_id, body, analysis, db)


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


# Registered LAST (after the literal /export path) so it never shadows that
# route — a variable path segment registered before a literal one would
# otherwise swallow it.
@router.get("/{conn_id}/slow-queries/{query_id}")
def get_slow_query_by_id(conn_id: int, query_id: str, db: Session = Depends(get_db)):
    """Lets the shared Slow Query detail page re-fetch by id on a refresh or
    direct link, instead of only working when router state carries the row."""
    from fastapi import HTTPException
    from app.services.common.slow_query_normalize import find_normalized_by_id
    response = mysql_slow_query_service.get_slow_queries(conn_id, db)
    row = find_normalized_by_id(response, query_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Query not found in the current slow-query window")
    return {"status": "success", "query": row}
