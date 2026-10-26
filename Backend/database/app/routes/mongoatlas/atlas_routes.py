"""MongoDB Atlas connections + monitoring. Every route needs a signed-in user; every connection-id route checks the
connection belongs to the caller's organisation (super admin = role 1 in org 1 sees all), and changes need the
Databases page's create / edit / delete permission. See services/mongoatlas/atlas_service.py for data sources."""
import concurrent.futures
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.routes.auth.auth_routes import current_claims
from app.services.auth.permission_guard import require_permission
from app.services.mongoatlas import atlas_service as svc

router = APIRouter(prefix="/api/v1/connections/mongoatlas", tags=["MongoDB Atlas"])
PAGE = "/databases"


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _super(claims):
    return claims.get("role_id") == 1 and claims.get("org_id") == 1


def _conn(db, conn_id, claims) -> ConnectionMaster:
    c = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id, ConnectionMaster.db_type == svc.DB_TYPE).first()
    if c is None or (not _super(claims) and c.org_id != claims.get("org_id")):
        raise HTTPException(404, "MongoDB Atlas connection not found.")
    return c


class AtlasConnIn(BaseModel):
    connection_name: str = Field(..., max_length=255)
    environment: Optional[str] = Field("Production", max_length=100)
    auth_method: str
    connection_uri: Optional[str] = Field(None, max_length=2000)
    host: Optional[str] = Field(None, max_length=500)
    username: Optional[str] = Field(None, max_length=255)
    password: Optional[str] = Field(None, max_length=500)
    auth_source: Optional[str] = Field(None, max_length=255)
    database_name: Optional[str] = Field(None, max_length=255)
    project_label: Optional[str] = Field(None, max_length=255)
    project_id: Optional[str] = Field(None, max_length=64)
    api_public_key: Optional[str] = Field(None, max_length=100)
    api_private_key: Optional[str] = Field(None, max_length=200)
    remove_api_key: bool = False
    monitoring_scope: List[str] = []


def _run_tests(conn, req=None):
    """Data plane and/or API, whichever is configured. Returns (ok, results)."""
    res = {}
    if svc._has_data_plane(conn):
        res["database"] = svc.test_data_plane(conn)
    c = svc._cfg(conn)
    if c.get("project_id") and c.get("api_public_key") and (conn.cloud_primary_key_enc or (req and req.api_private_key)):
        res["api"] = svc.test_api(conn, private_key=(req.api_private_key if req and req.api_private_key else None))
    ok = bool(res) and all(r.get("ok") for r in res.values())
    return ok, res


def _stamp(conn, ok, res):
    c = svc._cfg(conn)
    c["last_status"] = "connected" if ok else "error"
    c["last_checked"] = datetime.now(timezone.utc).isoformat()
    c["last_error"] = None if ok else next((r.get("message") for r in res.values() if not r.get("ok")), None)
    conn.cloud_config = c


@router.get("/")
def list_connections(db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    q = db.query(ConnectionMaster).filter(ConnectionMaster.db_type == svc.DB_TYPE)
    if not _super(claims):
        q = q.filter(ConnectionMaster.org_id == claims.get("org_id"))
    return [svc.serialize(c) for c in q.order_by(ConnectionMaster.connection_name).all()]


@router.post("/test")
def test_unsaved(req: AtlasConnIn, existing_id: Optional[int] = None, db: Session = Depends(get_db),
                 claims: dict = Depends(current_claims)):
    """Test BEFORE saving. On an edit, blank secrets fall back to the stored ones. Nothing is written."""
    existing = _conn(db, existing_id, claims) if existing_id else None
    errs = svc.validate(req, existing)
    if errs:
        raise HTTPException(422, {"errors": errs})
    probe = ConnectionMaster(id=existing.id if existing else 0, cloud_config=dict(existing.cloud_config or {}) if existing else {},
                             connection_uri=existing.connection_uri if existing else None,
                             password=existing.password if existing else None,
                             cloud_primary_key_enc=existing.cloud_primary_key_enc if existing else None)
    svc.apply(probe, req)
    ok, res = _run_tests(probe, req)
    return {"ok": ok, "results": res}


@router.post("/")
def create(req: AtlasConnIn, db: Session = Depends(get_db), claims: dict = Depends(require_permission(PAGE, "add"))):
    errs = svc.validate(req)
    if errs:
        raise HTTPException(422, {"errors": errs})
    conn = svc.apply(ConnectionMaster(org_id=claims.get("org_id") or 1, registration_mode="cloud", cloud_config={}), req)
    ok, res = _run_tests(conn, req)
    if not ok:   # saved only after it actually connects
        raise HTTPException(400, {"message": "Connection test failed — not saved.", "results": res})
    c = svc._cfg(conn)
    c["created_at"] = datetime.now(timezone.utc).isoformat()
    conn.cloud_config = c
    _stamp(conn, ok, res)
    db.add(conn)
    db.commit()
    db.refresh(conn)
    return {"status": "success", "connection": svc.serialize(conn), "results": res}


@router.get("/{conn_id}")
def get_one(conn_id: int, db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    return svc.serialize(_conn(db, conn_id, claims))


@router.put("/{conn_id}")
def update(conn_id: int, req: AtlasConnIn, db: Session = Depends(get_db), claims: dict = Depends(require_permission(PAGE, "edit"))):
    conn = _conn(db, conn_id, claims)
    errs = svc.validate(req, conn)
    if errs:
        raise HTTPException(422, {"errors": errs})
    svc.apply(conn, req)
    ok, res = _run_tests(conn, req)
    if not ok:
        db.rollback()
        raise HTTPException(400, {"message": "Connection test failed — changes not saved.", "results": res})
    _stamp(conn, ok, res)
    db.commit()
    svc.drop_cache(conn_id)
    return {"status": "success", "connection": svc.serialize(conn), "results": res}


@router.delete("/{conn_id}")
def delete(conn_id: int, db: Session = Depends(get_db), claims: dict = Depends(require_permission(PAGE, "delete"))):
    conn = _conn(db, conn_id, claims)
    db.delete(conn)   # removes the encrypted URI / password / API key with the row
    db.commit()
    svc.drop_cache(conn_id)
    return {"status": "success"}


@router.post("/{conn_id}/test")
def test_saved(conn_id: int, db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    conn = _conn(db, conn_id, claims)
    ok, res = _run_tests(conn)
    _stamp(conn, ok, res)
    db.commit()
    return {"ok": ok, "results": res}


# ── monitoring ────────────────────────────────────────────────────────────────

@router.get("/{conn_id}/overview")
def overview(conn_id: int, db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    conn = _conn(db, conn_id, claims)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
        f_dp = ex.submit(_safe, _db_view, conn)
        f_cl = ex.submit(_safe, svc.api_clusters, conn)
        f_al = ex.submit(_safe, svc.api_alerts, conn)
        dp, cl, al = f_dp.result(), f_cl.result(), f_al.result()
    reachable = dp.get("available") or cl.get("available")
    c = svc._cfg(conn)
    status = "connected" if reachable else "error"
    if c.get("last_status") != status:
        c["last_status"] = status
        c["last_checked"] = datetime.now(timezone.utc).isoformat()
        conn.cloud_config = c
        db.commit()
    return {"connection": svc.serialize(conn), "data_plane": dp, "clusters": cl, "alerts": al,
            "sampled": svc.sampled_series(conn.id), "fetched_at": datetime.now(timezone.utc).isoformat()}


def _safe(fn, *a):
    try:
        return fn(*a)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — a dead cluster must not 500 the whole dashboard
        kind, msg = svc._classify(exc)
        return {"available": False, "reason": svc._redact(msg), "kind": kind}


@router.get("/{conn_id}/clusters")
def clusters(conn_id: int, db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    conn = _conn(db, conn_id, claims)
    out = _safe(svc.api_clusters, conn)
    if out.get("available"):
        try:
            out["processes"] = svc.api_processes(conn)
        except svc.AtlasApiError as exc:
            out["processes_error"] = exc.message
    return out


@router.get("/{conn_id}/measurements")
def measurements(conn_id: int, process: str = Query(..., max_length=300), period: str = "1h",
                 db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    return _safe(svc.api_measurements, _conn(db, conn_id, claims), process, period)


@router.get("/{conn_id}/sampled")
def sampled(conn_id: int, db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    conn = _conn(db, conn_id, claims)
    _safe(svc.dp_overview, conn)    # takes a fresh sample
    return {"series": svc.sampled_series(conn.id)}


def _db_view(conn):
    """Database access when configured (exact, live); otherwise Atlas' database measurements (API key)."""
    if svc._has_data_plane(conn):
        return svc.dp_overview(conn)
    return svc.api_database_stats(conn)


@router.get("/{conn_id}/databases")
def databases(conn_id: int, db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    return _safe(_db_view, _conn(db, conn_id, claims))


@router.get("/{conn_id}/nodes")
def nodes(conn_id: int, db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    return _safe(svc.api_node_usage, _conn(db, conn_id, claims))


@router.get("/{conn_id}/collections")
def collections(conn_id: int, database: str = Query(..., max_length=64), db: Session = Depends(get_db),
                claims: dict = Depends(current_claims)):
    return _safe(svc.dp_collections, _conn(db, conn_id, claims), database)


@router.get("/{conn_id}/indexes")
def indexes(conn_id: int, database: str = Query(..., max_length=64), collection: str = Query(..., max_length=120),
            db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    return _safe(svc.dp_indexes, _conn(db, conn_id, claims), database, collection)


@router.get("/{conn_id}/replication")
def replication(conn_id: int, db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    return _safe(svc.dp_replication, _conn(db, conn_id, claims))


@router.get("/{conn_id}/current-ops")
def current_ops(conn_id: int, min_secs: int = Query(0, ge=0, le=3600), db: Session = Depends(get_db),
                claims: dict = Depends(current_claims)):
    return _safe(svc.dp_current_ops, _conn(db, conn_id, claims), min_secs)


@router.get("/{conn_id}/slow-queries")
def slow_queries(conn_id: int, process: str = Query(..., max_length=300), hours: int = Query(24, ge=1, le=168),
                 db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    return _safe(svc.api_slow_queries, _conn(db, conn_id, claims), process, hours)


@router.get("/{conn_id}/alerts")
def alerts(conn_id: int, status: str = "OPEN", db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    return _safe(svc.api_alerts, _conn(db, conn_id, claims), status)


class AckIn(BaseModel):
    hours: int = Field(24, ge=1, le=720)


@router.post("/{conn_id}/alerts/{alert_id}/ack")
def ack_alert(conn_id: int, alert_id: str, req: AckIn, db: Session = Depends(get_db),
              claims: dict = Depends(require_permission("/alerts", "edit"))):
    return svc.api_ack_alert(_conn(db, conn_id, claims), alert_id, req.hours)


@router.get("/{conn_id}/cluster-usage")
def cluster_usage(conn_id: int, db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    return _safe(svc.api_cluster_usage, _conn(db, conn_id, claims))


@router.get("/{conn_id}/storage-trend")
def storage_trend(conn_id: int, process: Optional[str] = Query(None, max_length=300), period: str = "1h",
                  db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    """Atlas per-database history when the tier reports it; otherwise ActMon's own dbStats samples."""
    conn = _conn(db, conn_id, claims)
    out = None
    if process and svc._has_api(conn):
        out = _safe(svc.api_storage_series, conn, process, period)
        if out.get("available"):
            return out
    if svc._has_data_plane(conn):
        return {"available": True, "source": "sampled", "series": svc.sampled_storage(conn.id)}
    return out or {"available": False, "reason": "Storage history needs an Atlas API key or database access.", "requires": "api_key"}


@router.get("/{conn_id}/cost")
def cost(conn_id: int, db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    return _safe(svc.api_cost, _conn(db, conn_id, claims))


@router.get("/{conn_id}/backups")
def backups(conn_id: int, db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    return _safe(svc.api_backups, _conn(db, conn_id, claims))


@router.get("/{conn_id}/security")
def security(conn_id: int, db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    return _safe(svc.api_security, _conn(db, conn_id, claims))
