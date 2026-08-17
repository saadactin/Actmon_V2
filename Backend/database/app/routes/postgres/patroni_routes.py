"""
Patroni-aware PostgreSQL HA console — routes.
All business logic lives in app/services/postgres/patroni_cluster_service.py.

RBAC reuses the EXISTING page `/postgresql-dashboard/:id/replication`
(page_id 89, already gates the plain Replication tab) — no new page/permission
rows. Read routes are consistent with postgres_monitoring_routes.py's existing
convention (authenticated via current_claims, no additional per-route
permission gate on GETs); every mutating route requires the specific bit.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.routes.auth.auth_routes import current_claims
from app.services.auth.permission_guard import check_permission, require_permission
from app.services.postgres.patroni_cluster_service import (
    svc_patroni_status,
    svc_patroni_topology,
    svc_patroni_slots,
    svc_patroni_config,
    svc_patroni_config_apply,
    svc_patroni_config_history,
    svc_patroni_yaml_read,
    svc_patroni_yaml_write,
    svc_patroni_logs,
    svc_patroni_history,
    svc_patroni_action,
    svc_patroni_action_history,
    svc_patroni_diagnose,
    svc_patroni_ai_precheck,
    _RESTART_ACTIONS,
)

router = APIRouter(prefix="/api/v1/connections/postgresql/{conn_id}/patroni", tags=["PostgreSQL Patroni"])

REPLICATION_PAGE = "/postgresql-dashboard/:id/replication"


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/status")
def route_status(conn_id: int, db: Session = Depends(get_db)):
    return svc_patroni_status(conn_id, db)


@router.get("/topology")
def route_topology(conn_id: int, db: Session = Depends(get_db)):
    return svc_patroni_topology(conn_id, db)


@router.get("/slots")
def route_slots(conn_id: int, db: Session = Depends(get_db)):
    return svc_patroni_slots(conn_id, db)


@router.get("/history")
def route_history(conn_id: int, db: Session = Depends(get_db)):
    return svc_patroni_history(conn_id, db)


@router.get("/action-history")
def route_action_history(conn_id: int, db: Session = Depends(get_db)):
    return svc_patroni_action_history(conn_id, db)


@router.get("/diagnose")
def route_diagnose(conn_id: int, member: str, db: Session = Depends(get_db)):
    return svc_patroni_diagnose(conn_id, member, db)


class AiPrecheckBody(BaseModel):
    member: str


@router.post("/ai-precheck")
def route_ai_precheck(conn_id: int, body: AiPrecheckBody, db: Session = Depends(get_db)):
    """AI Pre-check (§3B) — advisory only, reuses ActMon's existing hidden Groq
    integration. Never executes any action itself; the real Restart Patroni
    action still goes through /action with its own RBAC + re-auth + audit."""
    return svc_patroni_ai_precheck(conn_id, body.member, db)


@router.get("/ch-history")
def route_ch_history(conn_id: int, minutes: Optional[int] = 1440):
    """Embedded 'leader changes / lag trend' panel data — ClickHouse-backed,
    arbitrary time window (defaults to the last 24h). A full standalone
    Reports page with Live/2h/Daily/Weekly/Monthly/Custom presets is
    follow-up work; this is the query capability plus one embedded view."""
    from app.services.clickhouse.metrics_history_service import (
        query_postgres_patroni_members, query_postgres_patroni_transitions,
    )
    return {
        "members": query_postgres_patroni_members(conn_id, minutes=minutes),
        "transitions": query_postgres_patroni_transitions(conn_id, minutes=minutes),
    }


@router.get("/logs")
def route_logs(conn_id: int, server_id: int, unit: str = "patroni", since: str = "2 hours ago",
               db: Session = Depends(get_db)):
    return svc_patroni_logs(server_id, unit, since, db)


@router.get("/config")
def route_config(conn_id: int, db: Session = Depends(get_db)):
    return svc_patroni_config(conn_id, db)


@router.get("/config/history")
def route_config_history(conn_id: int, db: Session = Depends(get_db)):
    return svc_patroni_config_history(conn_id, db)


class ConfigApplyBody(BaseModel):
    changes: dict


@router.patch("/config")
def route_config_apply(conn_id: int, body: ConfigApplyBody,
                        claims: dict = Depends(current_claims), db: Session = Depends(get_db),
                        _perm: dict = Depends(require_permission(REPLICATION_PAGE, "edit"))):
    return svc_patroni_config_apply(conn_id, body.changes, claims.get("user_id"), db)


@router.get("/yaml")
def route_yaml_read(conn_id: int, server_id: int, path: Optional[str] = None,
                     db: Session = Depends(get_db)):
    return svc_patroni_yaml_read(server_id, path, db)


class YamlWriteBody(BaseModel):
    server_id: int
    path: Optional[str] = None
    content: str
    password: str


@router.put("/yaml")
def route_yaml_write(conn_id: int, body: YamlWriteBody,
                      claims: dict = Depends(current_claims), db: Session = Depends(get_db),
                      _perm: dict = Depends(require_permission(REPLICATION_PAGE, "edit"))):
    return svc_patroni_yaml_write(body.server_id, body.path, body.content, conn_id,
                                  claims.get("user_id"), body.password, db)


class ActionBody(BaseModel):
    action: str
    target: Optional[str] = None
    password: str


@router.post("/action")
def route_action(conn_id: int, body: ActionBody,
                  claims: dict = Depends(current_claims), db: Session = Depends(get_db)):
    # Required bit depends on the action itself (dynamic, same pattern as
    # os_server_routes.py's /service-action), so it can't be a static Depends().
    action = (body.action or "").lower()
    bit = "restart" if action in _RESTART_ACTIONS else "execute"
    check_permission(claims, db, REPLICATION_PAGE, bit)
    return svc_patroni_action(conn_id, action, body.target, claims.get("user_id"), body.password, db)
