"""CPU Performance history APIs (ClickHouse host_cpu_metrics / host_process_cpu). Authenticated and org-scoped the
same way as the Memory APIs: the host is resolved through the org-filtered lookup, so another organisation's host
is a 404. Read-only."""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.routes.auth.auth_routes import current_claims
from app.routes.os_server.memory_routes import _auth, _host, get_db
from app.services.clickhouse.memory_history_service import MemoryHistoryUnavailable

router = APIRouter(prefix="/api/v1/cpu", tags=["CPU"])


def _cpu_run(fn, *a):
    try:
        return fn(*a)
    except MemoryHistoryUnavailable as e:
        raise HTTPException(status_code=503, detail=f"CPU history unavailable: {e}")


@router.get("/{server_id}/categories")
def route_cpu_categories(server_id: int, minutes: int = 60, bucket: int = 60, db: Session = Depends(get_db), ctx: dict = Depends(_auth)):
    from app.services.clickhouse import cpu_history_service as ch
    sid = _host(server_id, db, ctx)
    return {"server_id": sid, "minutes": minutes, "bucket": bucket, "samples": _cpu_run(ch.category_history, sid, minutes, bucket)}


@router.get("/{server_id}/processes")
def route_cpu_processes(server_id: int, at: int = Query(..., description="epoch ms"), tolerance_s: int = Query(180, ge=10, le=900),
                        db: Session = Depends(get_db), ctx: dict = Depends(_auth)):
    from app.services.clickhouse import cpu_history_service as ch
    return _cpu_run(ch.processes_at, _host(server_id, db, ctx), at, tolerance_s)


@router.get("/{server_id}/process-trend")
def route_cpu_process_trend(server_id: int, pid: int, minutes: int = 60, bucket: int = 60, db: Session = Depends(get_db), ctx: dict = Depends(_auth)):
    from app.services.clickhouse import cpu_history_service as ch
    sid = _host(server_id, db, ctx)
    return {"server_id": sid, "pid": pid, "samples": _cpu_run(ch.process_trend, sid, pid, minutes, bucket)}


@router.get("/{server_id}/process-detail")
def route_cpu_process_detail(server_id: int, pid: int = Query(..., ge=1, le=4194304), db: Session = Depends(get_db),
                             ctx: dict = Depends(_auth), claims: dict = Depends(current_claims)):
    """Live, read-only details for one process. Full command line and the open-file list need Infrastructure
    "execute"; everyone else who can see the host gets the masked command line and the open-file COUNT."""
    from app.models.os_server_model import OsServer
    from app.services.auth.permission_guard import check_permission
    from app.services.os_server import process_detail_service as pd
    sid = _host(server_id, db, ctx)
    server = db.query(OsServer).filter(OsServer.id == sid).first()
    try:
        check_permission(claims, db, "/infra", "execute")
        full = True
    except HTTPException:
        full = False
    try:
        return pd.run(server, pid, full)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
