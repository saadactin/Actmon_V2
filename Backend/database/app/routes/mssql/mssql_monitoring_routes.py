from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.mssql import mssql_monitoring_service
from app.services.mssql import mssql_ai_analysis

router = APIRouter(
    prefix="/api/v1/connections/mssql",
    tags=["MSSQL Monitoring"]
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/{conn_id}/monitoring-dashboard")
def get_monitoring_dashboard(conn_id: int, db: Session = Depends(get_db)):
    return mssql_monitoring_service.get_monitoring_dashboard(conn_id, db)


@router.get("/{conn_id}/mssql-slow-queries")
def get_mssql_slow_queries(conn_id: int, db: Session = Depends(get_db)):
    return mssql_monitoring_service.get_slow_queries(conn_id, db)


@router.post("/{conn_id}/mssql-slow-queries/analyze-groq")
def analyze_mssql_slow_query(conn_id: int, payload: mssql_ai_analysis.MssqlSlowQueryGroqRequest,
                             db: Session = Depends(get_db)):
    return mssql_ai_analysis.analyze_slow_query_groq(conn_id, payload, db)


@router.get("/{conn_id}/mssql-slow-queries/{query_id}")
def get_mssql_slow_query_by_id(conn_id: int, query_id: str, db: Session = Depends(get_db)):
    """Lets the shared Slow Query detail page re-fetch by id on a refresh or
    direct link, instead of only working when router state carries the row."""
    from app.services.common.slow_query_normalize import find_normalized_by_id
    response = mssql_monitoring_service.get_slow_queries(conn_id, db)
    row = find_normalized_by_id(response, query_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Query not found in the current slow-query window")
    return {"status": "success", "query": row}


@router.get("/{conn_id}/mssql-error-logs")
def get_mssql_error_logs(conn_id: int, db: Session = Depends(get_db)):
    return mssql_monitoring_service.get_error_logs(conn_id, db)


@router.get("/{conn_id}/mssql-index-analysis")
def get_mssql_index_analysis(conn_id: int, db: Session = Depends(get_db)):
    return mssql_monitoring_service.get_index_analysis(conn_id, db)
