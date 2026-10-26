"""Memory Analysis / Memory Pressure APIs. Authenticated (valid token required) and org-scoped: the host is resolved
through the same org-filtered lookup as GET /os-servers/{id}, so another organisation's host is a 404 and nothing
else is queried. Read-only."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.os_server_model import OsServer
from app.routes.auth.auth_routes import current_claims
from app.services.auth.tenant_context import scope_org_id, tenant_ctx
from app.services.clickhouse.memory_history_service import MemoryHistoryUnavailable
from app.services.os_server import memory_service as ms

router = APIRouter(prefix="/api/v1/memory", tags=["Memory"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _host(server_id: int, db: Session, ctx: dict) -> int:
    q = db.query(OsServer.id).filter(OsServer.id == server_id)
    org = scope_org_id(ctx)
    if org is not None:
        q = q.filter(OsServer.org_id == org)
    if not q.first():
        raise HTTPException(status_code=404, detail="Server not found")
    return server_id


def _run(fn, *a):
    try:
        return fn(*a)
    except ms.BadRequest as e:
        raise HTTPException(status_code=422, detail=str(e))
    except MemoryHistoryUnavailable as e:
        raise HTTPException(status_code=503, detail=f"Memory history unavailable: {e}")


def _auth(claims: dict = Depends(current_claims), ctx: dict = Depends(tenant_ctx)) -> dict:
    return ctx


@router.get("/{server_id}/history")
def route_history(server_id: int, minutes: int = 60, bucket: int = 60, db: Session = Depends(get_db), ctx: dict = Depends(_auth)):
    sid = _host(server_id, db, ctx)
    return {"server_id": sid, "minutes": minutes, "bucket": bucket,
            "samples": _run(ms.history, sid, minutes, bucket), "stats": _run(ms.stats, sid, minutes)}


@router.get("/{server_id}/snapshot")
def route_snapshot(server_id: int, at: int = Query(..., description="epoch ms"), tolerance_s: Optional[int] = Query(None, ge=5, le=900),
                   db: Session = Depends(get_db), ctx: dict = Depends(_auth)):
    return _run(ms.snapshot_at, _host(server_id, db, ctx), at, tolerance_s)


@router.get("/{server_id}/process-history")
def route_process_history(server_id: int, pid: int, name: str = Query(..., max_length=120), start: Optional[int] = None,
                          minutes: int = 60, bucket: int = 60, db: Session = Depends(get_db), ctx: dict = Depends(_auth)):
    return {"points": _run(ms.process_history, _host(server_id, db, ctx), pid, name, start, minutes, bucket)}


@router.get("/{server_id}/top-processes")
def route_top_processes(server_id: int, minutes: int = 60, bucket: int = 60, n: int = Query(5, ge=1, le=10),
                        db: Session = Depends(get_db), ctx: dict = Depends(_auth)):
    return _run(ms.top_timeline, _host(server_id, db, ctx), minutes, bucket, n)


@router.get("/{server_id}/analysis")
def route_analysis(server_id: int, minutes: int = 60, bucket: int = 60, threshold: Optional[float] = Query(None, ge=1, le=100),
                   db: Session = Depends(get_db), ctx: dict = Depends(_auth)):
    return _run(ms.analysis, _host(server_id, db, ctx), minutes, bucket, threshold)


# ── Disk Consumption (/api/v1/disk/...) — same auth + org scoping ──────────────────────────────────
from app.services.os_server import disk_service as ds  # noqa: E402

disk_router = APIRouter(prefix="/api/v1/disk", tags=["Disk"])


@disk_router.get("/{server_id}/history")
def route_disk_history(server_id: int, minutes: int = 60, bucket: int = 60, db: Session = Depends(get_db), ctx: dict = Depends(_auth)):
    sid = _host(server_id, db, ctx)
    return {"server_id": sid, "samples": _run(ds.history, sid, minutes, bucket), "stats": _run(ds.stats, sid, minutes),
            "mounts": _run(ds.mounts, sid, minutes)}


@disk_router.get("/{server_id}/mount-history")
def route_disk_mount_history(server_id: int, mount: str = Query(..., max_length=200), minutes: int = 60, bucket: int = 60,
                             db: Session = Depends(get_db), ctx: dict = Depends(_auth)):
    return {"points": _run(ds.mount_history, _host(server_id, db, ctx), mount, minutes, bucket)}


@disk_router.get("/{server_id}/network-history")
def route_network_history(server_id: int, minutes: int = 60, bucket: int = 60, db: Session = Depends(get_db), ctx: dict = Depends(_auth)):
    """Host network throughput history (lives beside disk: same host-resource family, same auth)."""
    return {"samples": _run(ds.net_history, _host(server_id, db, ctx), minutes, bucket)}


# ── Infrastructure fleet history (/api/v1/infra-fleet/history) ────────────────────────────────────
# Average CPU / memory / disk across the caller's hosts over time, from the existing ClickHouse
# metrics_infra table (kind='infra', tech='host' — the host's own readings, never its DB engines' rows).
# Each host is averaged per bucket FIRST, then hosts are averaged — so an agent reporting every 15 s and an
# SSH host polled every 3 min weigh the same. Org-scoped through the same OsServer lookup.
fleet_router = APIRouter(prefix="/api/v1/infra-fleet", tags=["Infrastructure"])


@fleet_router.get("/history")
def route_fleet_history(minutes: int = 60, bucket: int = 60, server_id: Optional[int] = None,
                        db: Session = Depends(get_db), ctx: dict = Depends(_auth)):
    from app.services.clickhouse.metrics_history_service import CH_DB, get_client
    try:
        ms.validate(minutes, bucket or 60)
    except ms.BadRequest as e:
        raise HTTPException(status_code=422, detail=str(e))
    q = db.query(OsServer.server_name)
    org = scope_org_id(ctx)
    if org is not None:
        q = q.filter(OsServer.org_id == org)
    if server_id is not None:
        q = q.filter(OsServer.id == server_id)
    names = [n for (n,) in q.all() if n]
    if not names:
        return {"samples": [], "hosts": 0}
    cli = get_client()
    if cli is None:
        raise HTTPException(status_code=503, detail="Fleet history unavailable: ClickHouse is unavailable")
    try:
        r = cli.query(f"""
            SELECT t, avg(c) AS cpu, avg(m) AS memory, avg(d) AS disk, count() AS hosts FROM (
              SELECT toUnixTimestamp(toStartOfInterval(ts, INTERVAL {{b:UInt32}} SECOND)) * 1000 AS t, agent,
                     avg(host_cpu) AS c, avg(host_memory) AS m, avg(host_disk) AS d
              FROM {CH_DB}.metrics_infra
              WHERE kind = 'infra' AND tech = 'host' AND agent IN {{names:Array(String)}}
                AND ts >= now() - INTERVAL {{m2:UInt32}} MINUTE
              GROUP BY t, agent)
            GROUP BY t ORDER BY t LIMIT 10000""", parameters={"b": bucket or 60, "names": names, "m2": minutes * 2})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"Fleet history query failed: {type(e).__name__}")
    rows = [dict(zip(r.column_names, x)) for x in r.result_rows]
    return {"samples": [{k: (round(v, 2) if isinstance(v, float) else v) for k, v in x.items()} for x in rows], "hosts": len(names)}

