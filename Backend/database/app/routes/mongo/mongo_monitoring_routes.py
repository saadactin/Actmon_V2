from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.mongo import mongo_monitoring_service

router = APIRouter(prefix="/api/v1/connections/mongodb", tags=["MongoDB Monitoring"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class MongoSlowOpGroqRequest(BaseModel):
    ns: str = ""
    op: str = ""
    millis: float = 0.0
    docs_examined: int = 0
    keys_examined: int = 0
    docs_returned: int = 0
    plan_summary: str = ""
    filter_json: str = ""
    client: str = ""


@router.get("/{conn_id}/mongo-dashboard")
def mongo_dashboard(conn_id: int, db: Session = Depends(get_db)):
    return mongo_monitoring_service.get_dashboard(conn_id, db)


@router.get("/{conn_id}/mongo-ops")
def mongo_ops(conn_id: int, db: Session = Depends(get_db)):
    return mongo_monitoring_service.get_ops(conn_id, db)


@router.get("/{conn_id}/mongo-profiler")
def mongo_profiler(conn_id: int, db: Session = Depends(get_db)):
    return mongo_monitoring_service.get_profiler(conn_id, db)


@router.get("/{conn_id}/mongo-slow-operations")
def mongo_slow_operations(
    conn_id: int,
    db_name: Optional[str] = None,
    query_type: Optional[str] = None,
    severity: Optional[str] = None,
    user_name: Optional[str] = None,
    search: Optional[str] = None,
    min_avg_ms: Optional[float] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_dir: str = "desc",
    page: int = 1,
    page_size: int = 25,
    db: Session = Depends(get_db),
):
    return mongo_monitoring_service.get_slow_operations_filtered(
        conn_id, db, db_name=db_name, query_type=query_type, severity=severity,
        user_name=user_name, search=search, min_avg_ms=min_avg_ms,
        date_from=date_from, date_to=date_to, sort_by=sort_by, sort_dir=sort_dir,
        page=page, page_size=page_size,
    )


class MongoExplainRequest(BaseModel):
    database: str
    collection: str
    query_filter: dict = {}


@router.post("/{conn_id}/mongo-slow-ops/explain")
def mongo_slow_ops_explain(conn_id: int, payload: MongoExplainRequest, db: Session = Depends(get_db)):
    return mongo_monitoring_service.explain_operation(
        conn_id, payload.database, payload.collection, payload.query_filter, db
    )


@router.get("/{conn_id}/mongo-collections")
def mongo_collections(conn_id: int, db: Session = Depends(get_db)):
    return mongo_monitoring_service.get_collections(conn_id, db)


@router.get("/{conn_id}/mongo-indexes")
def mongo_indexes(conn_id: int, db: Session = Depends(get_db)):
    return mongo_monitoring_service.get_indexes(conn_id, db)


@router.get("/{conn_id}/mongo-replication")
def mongo_replication(conn_id: int, db: Session = Depends(get_db)):
    return mongo_monitoring_service.get_replication(conn_id, db)


@router.get("/{conn_id}/mongo-oplog")
def mongo_oplog(conn_id: int, db: Session = Depends(get_db)):
    return mongo_monitoring_service.get_oplog(conn_id, db)


@router.get("/{conn_id}/mongo-sharding")
def mongo_sharding(conn_id: int, db: Session = Depends(get_db)):
    return mongo_monitoring_service.get_sharding(conn_id, db)


@router.get("/{conn_id}/mongo-transactions")
def mongo_transactions(conn_id: int, db: Session = Depends(get_db)):
    return mongo_monitoring_service.get_transactions(conn_id, db)


@router.get("/{conn_id}/mongo-wiredtiger")
def mongo_wiredtiger(conn_id: int, db: Session = Depends(get_db)):
    return mongo_monitoring_service.get_wiredtiger(conn_id, db)


@router.get("/{conn_id}/mongo-users")
def mongo_users(conn_id: int, db: Session = Depends(get_db)):
    return mongo_monitoring_service.get_users(conn_id, db)


@router.get("/{conn_id}/mongo-error-logs")
def mongo_error_logs(conn_id: int, db: Session = Depends(get_db)):
    return mongo_monitoring_service.get_error_logs(conn_id, db)


@router.get("/{conn_id}/mongo-collection-analysis")
def mongo_collection_analysis(conn_id: int, db: Session = Depends(get_db)):
    return mongo_monitoring_service.get_collection_analysis(conn_id, db)


@router.post("/{conn_id}/mongo-slow-ops/analyze-groq")
def mongo_analyze_slow_op_groq(
    conn_id: int,
    payload: MongoSlowOpGroqRequest,
    db: Session = Depends(get_db),
):
    return mongo_monitoring_service.analyze_slow_op_groq(conn_id, payload, db)


@router.get("/{conn_id}/mongo-collection-detail/{db_name}/{coll_name}")
def mongo_collection_detail(
    conn_id: int,
    db_name: str,
    coll_name: str,
    db: Session = Depends(get_db),
):
    return mongo_monitoring_service.get_collection_detail(conn_id, db_name, coll_name, db)


@router.get("/{conn_id}/monitoring-dashboard")
def monitoring_dashboard(conn_id: int, db: Session = Depends(get_db)):
    return mongo_monitoring_service.get_dashboard(conn_id, db)
