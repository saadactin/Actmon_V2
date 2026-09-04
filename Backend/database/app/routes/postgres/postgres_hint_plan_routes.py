"""
PostgreSQL Query Plan Analysis — pg_hint_plan availability, EXPLAIN/EXPLAIN
ANALYZE, hint validation, plan comparison, and comparison history.
Read-only diagnostics only — see postgres_hint_plan_service.py for the
production-safety reasoning behind every check here.
"""

from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.routes.auth.auth_routes import current_claims
from app.services.postgres.postgres_hint_plan_service import (
    HINT_TEMPLATES,
    pg_hint_plan_availability,
    validate_hint,
    table_stats_for_hint,
    run_plan_comparison,
    list_plan_comparisons,
    get_plan_comparison,
)

router = APIRouter(prefix="/api/v1", tags=["PostgreSQL Plan Analysis"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class ValidateHintBody(BaseModel):
    hint_text: str
    database: Optional[str] = None


class RunComparisonBody(BaseModel):
    sql_text: str
    hint_text: Optional[str] = None
    analyze: bool = False  # explicit opt-in — never implied, never defaulted true
    database: Optional[str] = None
    timeout_ms: Optional[int] = None


@router.get("/connections/postgresql/{conn_id}/pg-hint-plan/availability")
def route_pg_hint_plan_availability(conn_id: int, db: Session = Depends(get_db)):
    return pg_hint_plan_availability(conn_id, db)


@router.get("/connections/postgresql/{conn_id}/pg-hint-plan/templates")
def route_hint_templates():
    return {"status": "success", "templates": HINT_TEMPLATES}


@router.post("/connections/postgresql/{conn_id}/pg-hint-plan/validate")
def route_validate_hint(conn_id: int, body: ValidateHintBody, db: Session = Depends(get_db)):
    return validate_hint(conn_id, db, body.hint_text, body.database)


@router.get("/connections/postgresql/{conn_id}/pg-hint-plan/table-stats")
def route_table_stats(conn_id: int, table_name: str, database: Optional[str] = None, db: Session = Depends(get_db)):
    return table_stats_for_hint(conn_id, db, table_name, database)


@router.post("/connections/postgresql/{conn_id}/pg-hint-plan/compare")
def route_run_plan_comparison(
    conn_id: int, body: RunComparisonBody,
    claims: dict = Depends(current_claims), db: Session = Depends(get_db),
):
    return run_plan_comparison(
        conn_id, db, claims, body.sql_text,
        hint_text=body.hint_text, analyze=body.analyze,
        database=body.database, timeout_ms=body.timeout_ms,
    )


@router.get("/connections/postgresql/{conn_id}/pg-hint-plan/history")
def route_list_plan_comparisons(conn_id: int, limit: int = 100, db: Session = Depends(get_db)):
    return list_plan_comparisons(conn_id, db, limit)


@router.get("/pg-hint-plan/history/{comparison_id}")
def route_get_plan_comparison(comparison_id: int, db: Session = Depends(get_db)):
    return get_plan_comparison(comparison_id, db)
