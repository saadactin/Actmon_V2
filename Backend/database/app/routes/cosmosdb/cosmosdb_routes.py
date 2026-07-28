from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.connection_schema import CosmosDBConnectionCreate
from app.services.cosmosdb import cosmosdb_service
from app.services.auth.tenant_context import tenant_ctx, scope_org_id, create_org_id

router = APIRouter(prefix="/api/v1/connections/cosmosdb", tags=["Azure Cosmos DB"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/")
def list_cosmosdb_connections(db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return cosmosdb_service.list_connections(db, scope_org_id(ctx))


@router.post("/")
def create_cosmosdb_connection(request: CosmosDBConnectionCreate, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return cosmosdb_service.create_connection(request, db, create_org_id(ctx))


@router.get("/{connection_id}")
def get_cosmosdb_connection(connection_id: int, db: Session = Depends(get_db)):
    return cosmosdb_service.get_connection(connection_id, db)


@router.put("/{connection_id}")
def update_cosmosdb_connection(connection_id: int, request: CosmosDBConnectionCreate, db: Session = Depends(get_db)):
    return cosmosdb_service.update_connection(connection_id, request, db)


@router.delete("/{connection_id}")
def delete_cosmosdb_connection(connection_id: int, db: Session = Depends(get_db)):
    return cosmosdb_service.delete_connection(connection_id, db)


@router.post("/{connection_id}/test")
def test_cosmosdb_connection(connection_id: int, db: Session = Depends(get_db)):
    return cosmosdb_service.test_connection(connection_id, db)


@router.get("/{connection_id}/databases")
def list_cosmosdb_databases(connection_id: int, db: Session = Depends(get_db)):
    return cosmosdb_service.list_databases(connection_id, db)


@router.get("/{connection_id}/containers")
def list_cosmosdb_containers(connection_id: int, database: str = Query(...), db: Session = Depends(get_db)):
    return cosmosdb_service.list_containers(connection_id, database, db)


@router.get("/{connection_id}/items")
def browse_cosmosdb_items(
    connection_id: int,
    database: str = Query(...),
    container: str = Query(...),
    limit: int = Query(25, ge=1, le=200),
    continuation_token: Optional[str] = Query(None),
    sort_recent: bool = Query(False),
    filter_query: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    return cosmosdb_service.browse_items(connection_id, database, container, db, limit, continuation_token, sort_recent, filter_query)


class RunQueryBody(BaseModel):
    database: str
    container: str
    query: str
    limit: int = 50


@router.post("/{connection_id}/query")
def run_cosmosdb_query(connection_id: int, body: RunQueryBody, db: Session = Depends(get_db)):
    return cosmosdb_service.run_query(connection_id, body.database, body.container, body.query, db, body.limit)


@router.get("/{connection_id}/document-count")
def get_cosmosdb_document_count(
    connection_id: int, database: str = Query(...), container: str = Query(...), db: Session = Depends(get_db),
):
    return cosmosdb_service.get_document_count(connection_id, database, container, db)


@router.get("/{connection_id}/activity")
def get_cosmosdb_activity(connection_id: int, limit: int = Query(200, ge=1, le=1000), db: Session = Depends(get_db)):
    return cosmosdb_service.get_activity(connection_id, db, limit)


# ── Real SDK-derived detail (Endpoint + Primary Key only — no App Registration) ──

@router.get("/{connection_id}/container-details")
def get_cosmosdb_container_details(
    connection_id: int, database: str = Query(...), container: str = Query(...), db: Session = Depends(get_db),
):
    return cosmosdb_service.get_container_details(connection_id, database, container, db)


@router.get("/{connection_id}/document-stats")
def get_cosmosdb_document_stats(
    connection_id: int, database: str = Query(...), container: str = Query(...), db: Session = Depends(get_db),
):
    return cosmosdb_service.get_document_stats(connection_id, database, container, db)


@router.get("/{connection_id}/database-summary")
def get_cosmosdb_database_summary(connection_id: int, database: str = Query(...), db: Session = Depends(get_db)):
    return cosmosdb_service.get_database_summary(connection_id, database, db)


@router.get("/{connection_id}/ai-analysis")
def get_cosmosdb_ai_analysis(
    connection_id: int, database: str = Query(...), container: str = Query(...), db: Session = Depends(get_db),
):
    return cosmosdb_service.get_ai_analysis(connection_id, database, container, db)


@router.get("/{connection_id}/error-analysis/{log_id}")
def get_cosmosdb_error_ai_analysis(connection_id: int, log_id: int, db: Session = Depends(get_db)):
    return cosmosdb_service.get_error_ai_analysis(connection_id, log_id, db)
