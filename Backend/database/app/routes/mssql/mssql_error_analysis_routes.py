from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.mssql import mssql_error_service
from app.services.mssql import mssql_self_heal_service

router = APIRouter(
    prefix="/api/v1/mssql",
    tags=["MSSQL Error Analysis"]
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.post("/{connection_id}/analyze-error")
def analyze_mssql_error_endpoint(connection_id: int, error_data: dict, db: Session = Depends(get_db)):
    return mssql_error_service.analyze_error(connection_id, error_data, db)


# ── Deep error analysis + self-healing ────────────────────────────────────────
@router.post("/{connection_id}/error-deep-analysis")
def mssql_error_deep_analysis(connection_id: int, payload: dict, db: Session = Depends(get_db)):
    """What/why the error is, whether it is still occurring, diagnostics + remediation steps."""
    return mssql_self_heal_service.error_analysis(connection_id, payload, db)


@router.get("/{connection_id}/heal-permissions")
def mssql_heal_permissions(connection_id: int, db: Session = Depends(get_db)):
    """What the connected login is allowed to do (gates self-heal in the UI)."""
    return mssql_self_heal_service.heal_permissions(connection_id, db)


@router.post("/{connection_id}/run-command")
def mssql_run_command(connection_id: int, payload: dict, db: Session = Depends(get_db)):
    """Run a single diagnostic/remediation command (the embedded terminal). Writes are permission-gated."""
    return mssql_self_heal_service.run_command(connection_id, payload, db)


@router.get("/{connection_id}/error-logs")
def get_mssql_error_logs(connection_id: int, limit: int = 50, db: Session = Depends(get_db)):
    return mssql_error_service.get_error_logs(connection_id, limit, db)


@router.get("/{connection_id}/metrics")
def get_mssql_metrics(connection_id: int, db: Session = Depends(get_db)):
    return mssql_error_service.get_metrics(connection_id, db)
