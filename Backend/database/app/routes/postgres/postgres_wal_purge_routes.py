"""
Purge WAL Archive — routes. All business logic lives in
app/services/postgres/postgres_wal_purge_service.py.

RBAC reuses the EXISTING Config-tab page
(`/postgresql-dashboard/:id/config`) — no new page_master row/migration.
GETs are authenticated (current_claims) but not permission-gated, consistent
with postgres_monitoring_routes.py's convention; every mutating route
requires "edit" on that page. The trigger callback is the one deliberate
exception: it has NO auth dependency because it validates its own per-
schedule token — that's what a cron job / Scheduled Task calls, credential-
free, and it must work even for a user with no ActMon session at all.
"""
from typing import Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.routes.auth.auth_routes import current_claims
from app.services.auth.permission_guard import require_permission
from app.services.postgres.postgres_wal_purge_service import (
    svc_wal_archive_info,
    compute_safety,
    _public_safety,
    svc_wal_purge_config_get,
    svc_wal_purge_config_save,
    svc_wal_purge_preview,
    svc_wal_purge_test,
    svc_wal_purge_execute,
    svc_wal_purge_run_status,
    svc_wal_purge_schedule,
    svc_wal_purge_disable,
    svc_wal_purge_trigger,
    svc_wal_purge_history,
    svc_wal_purge_callback_base,
    svc_wal_purge_audit,
)

router = APIRouter(prefix="/api/v1/connections/postgresql", tags=["PostgreSQL WAL Purge"])

CONFIG_PAGE = "/postgresql-dashboard/:id/config"


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/{conn_id}/wal-purge/info")
def route_wal_purge_info(conn_id: int, db: Session = Depends(get_db), _claims=Depends(current_claims)):
    return svc_wal_archive_info(conn_id, db)


@router.get("/{conn_id}/wal-purge/safety")
def route_wal_purge_safety(conn_id: int, db: Session = Depends(get_db), _claims=Depends(current_claims)):
    return {"status": "success", "safety": _public_safety(compute_safety(conn_id, db))}


@router.get("/{conn_id}/wal-purge/config")
def route_wal_purge_config_get(conn_id: int, db: Session = Depends(get_db), _claims=Depends(current_claims)):
    return svc_wal_purge_config_get(conn_id, db)


class WalPurgeConfigBody(BaseModel):
    archive_dir: str
    cleanup_binary: Optional[str] = "pg_archivecleanup"
    cleanup_method: Optional[str] = "pg_archivecleanup"
    retention_preset: Optional[str] = "7d"
    retention_days: Optional[int] = 7
    require_standby_ok: Optional[bool] = True
    max_standby_lag_mb: Optional[int] = 1024
    frequency: Optional[str] = "daily"
    hour: Optional[int] = 2
    minute: Optional[int] = 30
    day_of_week: Optional[int] = 0
    day_of_month: Optional[int] = 1
    callback_base_url: Optional[str] = None
    missed_grace_minutes: Optional[int] = 15


@router.put("/{conn_id}/wal-purge/config")
def route_wal_purge_config_save(conn_id: int, body: WalPurgeConfigBody,
                                 claims: dict = Depends(current_claims), db: Session = Depends(get_db),
                                 _perm=Depends(require_permission(CONFIG_PAGE, "edit"))):
    return svc_wal_purge_config_save(conn_id, body.dict(), claims.get("user_id"), db)


@router.post("/{conn_id}/wal-purge/preview")
def route_wal_purge_preview(conn_id: int, claims: dict = Depends(current_claims), db: Session = Depends(get_db),
                            _perm=Depends(require_permission(CONFIG_PAGE, "edit"))):
    return svc_wal_purge_preview(conn_id, db, claims.get("user_id"))


@router.post("/{conn_id}/wal-purge/test")
def route_wal_purge_test(conn_id: int, claims: dict = Depends(current_claims), db: Session = Depends(get_db),
                         _perm=Depends(require_permission(CONFIG_PAGE, "edit"))):
    return svc_wal_purge_test(conn_id, db, claims.get("user_id"))


class WalPurgeExecuteBody(BaseModel):
    confirm: str
    acknowledge_warnings: Optional[bool] = False


@router.post("/{conn_id}/wal-purge/execute")
def route_wal_purge_execute(conn_id: int, body: WalPurgeExecuteBody,
                            claims: dict = Depends(current_claims), db: Session = Depends(get_db),
                            _perm=Depends(require_permission(CONFIG_PAGE, "edit"))):
    return svc_wal_purge_execute(conn_id, body.dict(), claims.get("user_id"), db)


@router.get("/{conn_id}/wal-purge/runs/{run_id}")
def route_wal_purge_run_status(conn_id: int, run_id: int, db: Session = Depends(get_db), _claims=Depends(current_claims)):
    """Poll target for a run started via /execute — real incremental
    progress (files/space done so far) instead of one long-held request."""
    return svc_wal_purge_run_status(conn_id, run_id, db)


class WalScheduleBody(BaseModel):
    confirm: str


@router.post("/{conn_id}/wal-purge/schedule")
def route_wal_purge_schedule(conn_id: int, body: WalScheduleBody, request: Request,
                             claims: dict = Depends(current_claims), db: Session = Depends(get_db),
                             _perm=Depends(require_permission(CONFIG_PAGE, "edit"))):
    # Last-resort callback URL when neither a saved value nor the agent's own
    # registry/env-var lookup has one — see _resolve_callback_base. Honors
    # X-Forwarded-Proto since this almost always sits behind a TLS-terminating
    # reverse proxy (uvicorn itself would otherwise report plain "http").
    scheme = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("host") or request.url.netloc
    request_base_url = f"{scheme}://{host}" if host else None
    return svc_wal_purge_schedule(conn_id, body.dict(), claims.get("user_id"), db, request_base_url)


@router.post("/{conn_id}/wal-purge/disable")
def route_wal_purge_disable(conn_id: int, claims: dict = Depends(current_claims), db: Session = Depends(get_db),
                            _perm=Depends(require_permission(CONFIG_PAGE, "edit"))):
    return svc_wal_purge_disable(conn_id, claims.get("user_id"), db)


@router.get("/{conn_id}/wal-purge/history")
def route_wal_purge_history(conn_id: int, limit: int = 50, offset: int = 0,
                            db: Session = Depends(get_db), _claims=Depends(current_claims)):
    return svc_wal_purge_history(conn_id, db, limit, offset)


@router.get("/{conn_id}/wal-purge/callback-base")
def route_wal_purge_callback_base(conn_id: int, db: Session = Depends(get_db), _claims=Depends(current_claims)):
    return svc_wal_purge_callback_base(conn_id, db)


@router.get("/{conn_id}/wal-purge/audit")
def route_wal_purge_audit(conn_id: int, limit: int = 100,
                          db: Session = Depends(get_db), _claims=Depends(current_claims)):
    return svc_wal_purge_audit(conn_id, db, limit)


# ── The trigger callback — deliberately unauthenticated (validates its own
#    per-schedule token) and outside the {conn_id} prefix, since the cron/
#    task entry only knows the schedule_id, not which connection it's for. ──

class WalPurgeTriggerBody(BaseModel):
    schedule_id: int
    token: str


@router.post("/wal-purge/trigger")
def route_wal_purge_trigger(body: WalPurgeTriggerBody, request: Request, db: Session = Depends(get_db)):
    source_ip = request.client.host if request.client else None
    return svc_wal_purge_trigger(body.schedule_id, body.token, source_ip, db)
