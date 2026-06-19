"""
Centralized Agent API Routes
==============================
All /api/v1/agents/* endpoints.

Architecture
------------
  Monitored DB ──► (agent_collector_service) ──► ACTMON PostgreSQL
                                                         │
                   Applications / Users ◄────────────── ┘
                         (read only via these routes)

No consumer route here connects directly to the monitored database.
Data is always served from pre-collected rows stored in ACTMON's own DB.
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.agent.agent_service import (
    AgentDataIngest,
    AgentRegisterRequest,
    NotificationReadRequest,
    svc_export_metrics_csv,
    svc_get_agent_dashboard,
    svc_get_agent_metrics,
    svc_get_agent_sql,
    svc_get_agent_wait_events,
    svc_get_notifications,
    svc_get_oracle_snapshot,
    svc_ingest_agent_data,
    svc_list_agents,
    svc_mark_notifications_read,
    svc_register_agent,
    svc_sync_connections_to_agents,
)

router = APIRouter(prefix="/api/v1/agents", tags=["Agents"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.post("/register", summary="Register a new monitoring agent")
def route_register_agent(req: AgentRegisterRequest, db: Session = Depends(get_db)):
    return svc_register_agent(req, db)


@router.post("/sync-connections", summary="Auto-create agents from saved DB connections")
def route_sync_connections_to_agents(db: Session = Depends(get_db)):
    return svc_sync_connections_to_agents(db)


@router.post("/data", summary="Agent data ingest")
def route_ingest_agent_data(payload: AgentDataIngest, db: Session = Depends(get_db)):
    return svc_ingest_agent_data(payload, db)


@router.get("/", summary="List all accessible agents")
def route_list_agents(db: Session = Depends(get_db)):
    return svc_list_agents(db)


# Must be declared before /{agent_name}/... to prevent 'notifications'
# being matched as an agent_name.
@router.get("/notifications/", summary="Get unread notifications")
def route_get_notifications(
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
):
    return svc_get_notifications(limit, db)


@router.post("/notifications/read", summary="Mark notifications as read")
def route_mark_notifications_read(
    payload: NotificationReadRequest,
    db: Session = Depends(get_db),
):
    return svc_mark_notifications_read(payload, db)


@router.get("/{agent_name}/dashboard", summary="Single-agent dashboard data")
def route_get_agent_dashboard(
    agent_name: str,
    hours: int = Query(6, ge=1, le=720),
    db: Session = Depends(get_db),
):
    return svc_get_agent_dashboard(agent_name, hours, db)


@router.get("/{agent_name}/metrics", summary="Metric chart drilldown")
def route_get_agent_metrics(
    agent_name: str,
    hours: int = Query(24, ge=1, le=720),
    db: Session = Depends(get_db),
):
    return svc_get_agent_metrics(agent_name, hours, db)


@router.get("/{agent_name}/sql", summary="SQL performance drilldown")
def route_get_agent_sql(
    agent_name: str,
    hours: int = Query(6, ge=1, le=720),
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
):
    return svc_get_agent_sql(agent_name, hours, limit, db)


@router.get("/{agent_name}/wait-events", summary="Wait event drilldown")
def route_get_agent_wait_events(
    agent_name: str,
    hours: int = Query(6, ge=1, le=720),
    db: Session = Depends(get_db),
):
    return svc_get_agent_wait_events(agent_name, hours, db)


@router.get("/{agent_name}/oracle-snapshot", summary="Latest Oracle DB snapshot")
def route_get_oracle_snapshot(agent_name: str, db: Session = Depends(get_db)):
    return svc_get_oracle_snapshot(agent_name, db)


@router.get("/{agent_name}/export/csv", summary="Export agent metrics as CSV")
def route_export_metrics_csv(
    agent_name: str,
    hours: int = Query(24, ge=1, le=720),
    db: Session = Depends(get_db),
):
    return svc_export_metrics_csv(agent_name, hours, db)
