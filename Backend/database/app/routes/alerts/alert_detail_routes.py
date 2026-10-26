"""
Alert Details view (Alerts → click an alert).

Every endpoint needs a logged-in user. All data is real:
  GET  /api/v1/alerts/detail?id=          the active alert (same list /alerts/active serves), resolved to its database
                                          connection and host, its thresholds, the history of the SAME subject
                                          (notifications, read and unread), recent events on the same source and
                                          the other alerts currently active for that source
  GET  /api/v1/alerts/detail/storage      Oracle tablespace trend + the tablespace's largest objects, from the
                                          ClickHouse storage history the collector already records
  GET  /api/v1/alerts/detail/comments     comments on an alert subject
  POST /api/v1/alerts/detail/comments     add one (author = the logged-in user)
Nothing here changes a monitored system. Acknowledge stays on the existing POST /alerts/active/ack.
"""
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.agent_model import Agent, AgentNotification
from app.models.alert_comment_model import AlertComment
from app.models.alert_rule_model import AlertRule
from app.models.connection_model import ConnectionMaster
from app.models.os_server_model import DatabaseInstance, OsServer
from app.routes.auth.auth_routes import current_claims
from app.services.common.time_utils import iso_utc

router = APIRouter(prefix="/api/v1/alerts/detail", tags=["Alerts"])

# main.py runs Base.metadata.create_all() before this module is imported, so create the one new table here
# (no-op when it already exists; never touches any other table).
try:
    from app.database.connection import engine as _engine
    AlertComment.__table__.create(bind=_engine, checkfirst=True)
except Exception as _e:  # noqa: BLE001 — DB offline at import: comments fail cleanly until the next start
    print(f"[alerts] alert_comments table not created: {type(_e).__name__}")

# The Oracle collector raises a tablespace alert above 85 % (oracle_history_flush_service) and the Oracle storage
# view treats 70–85 % as warning (oracle_monitoring_service) — the thresholds this alert type really uses.
TABLESPACE_THRESHOLDS = {"warning": 70.0, "critical": 85.0, "source": "Oracle collector (tablespace used > 85 %)"}
_TS_RE = re.compile(r"Tablespace (?P<name>\S+) is at (?P<pct>[\d.]+)% used \((?P<used>[\d.]+)MB / (?P<total>[\d.]+)MB\)")
_SVC_RE = re.compile(r"Oracle service (?P<name>\S+) is offline")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _subject_key(source, metric, message):
    return "|".join([source or "", metric or "", re.sub(r"\d+(?:\.\d+)?", "#", message or "")])[:600]


def _subject(message):
    m = _TS_RE.search(message or "")
    if m:
        used, total = float(m["used"]), float(m["total"])
        return {"kind": "tablespace", "name": m["name"], "used_pct": float(m["pct"]), "used_mb": used,
                "total_mb": total, "free_mb": round(total - used, 2)}
    m = _SVC_RE.search(message or "")
    if m:
        return {"kind": "oracle_service", "name": m["name"]}
    return {"kind": "generic", "name": None}


def _resolve_target(source, db):
    """Alert source (an agent / host / connection name) → database connection + host."""
    conn, server = None, None
    agent = db.query(Agent).filter(Agent.agent_name == source).first()
    if agent and agent.db_connection_id:
        conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == agent.db_connection_id).first()
    if conn is None:
        conn = (db.query(ConnectionMaster).filter(ConnectionMaster.connection_name.ilike(source or "")).first())
    if conn is not None:
        inst = db.query(DatabaseInstance).filter(DatabaseInstance.connection_id == conn.id).first()
        if inst is not None:
            server = db.query(OsServer).filter(OsServer.id == inst.server_id).first()
        if server is None and conn.host:
            server = db.query(OsServer).filter((OsServer.ip_address == conn.host) | (OsServer.hostname == conn.host)).first()
    if server is None:
        server = db.query(OsServer).filter((OsServer.server_name == source) | (OsServer.hostname == source)).first()
        if server is not None and conn is None:
            inst = next((i for i in (server.db_instances or []) if i.connection_id), None)
            if inst:
                conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == inst.connection_id).first()
    tech = (conn.db_type or "").lower() if conn else None
    out = {"conn_id": conn.id if conn else None, "tech": "mysql" if tech == "mariadb" else tech,
           "connection_name": conn.connection_name if conn else None,
           "db_host": conn.host if conn else None, "db_port": conn.port if conn else None,
           "database_name": (conn.service_name or conn.sid or conn.database_name) if conn else None,
           "environment": (conn.environment if conn else None) or (server.environment if server else None),
           "host": None, "oracle": None}
    if server is not None:
        out["host"] = {"server_id": server.id, "server_name": server.server_name, "hostname": server.hostname,
                       "ip_address": server.ip_address, "os_type": server.os_type, "status": server.status,
                       "uptime": server.uptime, "collector": server.collector}
    if tech == "oracle":
        from app.models.agent_model import AgentOracleSnapshot
        names = [n for n in (source, conn.connection_name if conn else None) if n]
        snap = (db.query(AgentOracleSnapshot).filter(AgentOracleSnapshot.agent_name.in_(names))
                .order_by(desc(AgentOracleSnapshot.captured_at)).first()) if names else None
        if snap is not None:
            out["oracle"] = {"version": snap.version, "instance_name": snap.instance_name, "startup_time": snap.startup_time,
                             "status": snap.status, "open_mode": snap.open_mode, "instance_role": snap.instance_role,
                             "log_mode": snap.log_mode, "captured_at": iso_utc(snap.captured_at)}
    return out


def _org_ok(claims, target, db):
    """Org scoping: a non-super user may only open alerts whose connection / host is in their organisation."""
    org, role = claims.get("org_id"), claims.get("role_id")
    if role == 1 and org == 1:
        return True
    ids = []
    if target.get("conn_id"):
        c = db.query(ConnectionMaster.org_id).filter(ConnectionMaster.id == target["conn_id"]).first()
        ids.append(c[0] if c else None)
    if target.get("host"):
        s = db.query(OsServer.org_id).filter(OsServer.id == target["host"]["server_id"]).first()
        ids.append(s[0] if s else None)
    return not ids or any(i == org for i in ids)


@router.get("")
def alert_detail(id: str = Query(..., max_length=64), db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    from app.routes.alerts.alert_routes import active_alerts   # the SAME list the Active tab shows
    active = active_alerts(conn_id=None, db=db)
    alert = next((a for a in active if str(a.get("id")) == id), None)
    if alert is None:
        raise HTTPException(status_code=404, detail="This alert is no longer active (acknowledged or resolved).")
    source = alert.get("source") or ""
    target = _resolve_target(source, db)
    if not _org_ok(claims, target, db):
        raise HTTPException(status_code=404, detail="This alert is no longer active (acknowledged or resolved).")
    subject = _subject(alert.get("message"))
    key = _subject_key(source, alert.get("metric"), alert.get("message"))

    # history of THIS subject (every notification, read or not) — the alert's own timeline
    history = []
    if str(id).startswith("n"):
        pattern = re.sub(r"\d+(?:\.\d+)?", "#", alert.get("message") or "")
        rows = (db.query(AgentNotification).filter(AgentNotification.agent_name == source)
                .order_by(desc(AgentNotification.created_at)).limit(2000).all())
        for n in rows:
            if re.sub(r"\d+(?:\.\d+)?", "#", n.message or "") == pattern:
                sub = _subject(n.message)
                history.append({"id": f"n{n.id}", "at": iso_utc(n.created_at), "severity": (n.severity or "info").lower(),
                                "message": n.message, "acknowledged": bool(n.is_read), "value": sub.get("used_pct")})
            if len(history) >= 200:
                break
    first_seen = history[-1]["at"] if history else alert.get("created_at")

    # recent events on the same source (any subject), last 24 h
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    recent = [{"id": f"n{n.id}", "at": iso_utc(n.created_at), "severity": (n.severity or "info").lower(), "message": n.message,
               "acknowledged": bool(n.is_read)}
              for n in (db.query(AgentNotification).filter(AgentNotification.agent_name == source, AgentNotification.created_at >= since)
                        .order_by(desc(AgentNotification.created_at)).limit(100).all())]

    related = [a for a in active if a.get("source") == source and str(a.get("id")) != id]

    thresholds = None
    if subject["kind"] == "tablespace":
        thresholds = TABLESPACE_THRESHOLDS
    elif alert.get("rule_id"):
        r = db.query(AlertRule).filter(AlertRule.id == alert["rule_id"]).first()
        if r:
            thresholds = {"warning" if (r.severity or "") == "warning" else "critical": r.threshold, "operator": r.operator,
                          "source": f"Rule: {r.name}"}
    rules = [{"id": r.id, "name": r.name, "severity": r.severity, "threshold": r.threshold, "operator": r.operator, "enabled": r.enabled}
             for r in db.query(AlertRule).filter(AlertRule.metric == alert.get("metric")).all()] if alert.get("metric") else []

    return {"alert": alert, "subject": subject, "target": target, "thresholds": thresholds, "rules": rules,
            "first_seen": first_seen, "occurrences": len(history) or 1, "history": history, "recent_events": recent,
            "related": related, "alert_key": key, "ackable": bool(re.match(r"^n\d+$", id))}


@router.get("/storage")
def alert_storage(conn_id: int, tablespace: str = Query(..., max_length=128), hours: int = Query(24, ge=1, le=24 * 30),
                  db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    """Tablespace trend + its largest objects, from actmon_oracle_storage_history (collector-recorded)."""
    conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if conn is None or (not (claims.get("role_id") == 1 and claims.get("org_id") == 1) and conn.org_id != claims.get("org_id")):
        raise HTTPException(status_code=404, detail="Connection not found")
    from app.services.clickhouse.metrics_history_service import CH_DB, get_client
    cli = get_client()
    if cli is None:
        raise HTTPException(status_code=503, detail="Storage history unavailable: ClickHouse is unavailable")
    bucket = 300 if hours <= 24 else 3600
    try:
        trend = cli.query(f"""
            SELECT toUnixTimestamp(toStartOfInterval(ts, INTERVAL {{b:UInt32}} SECOND)) * 1000 AS t,
                   round(avg(used_pct), 2) AS used_pct, round(avg(size_mb), 2) AS used_mb, round(avg(total_mb), 2) AS total_mb
            FROM {CH_DB}.actmon_oracle_storage_history
            WHERE conn_id = {{c:UInt32}} AND metric_type = 'tablespace' AND object_name = {{ts:String}}
              AND ts >= now() - INTERVAL {{h:UInt32}} HOUR
            GROUP BY t ORDER BY t""", parameters={"c": conn_id, "ts": tablespace, "h": hours, "b": bucket}).result_rows
        latest_seg = cli.query(f"""
            SELECT max(ts) FROM {CH_DB}.actmon_oracle_storage_history
            WHERE conn_id = {{c:UInt32}} AND metric_type = 'segment' AND tablespace_name = {{ts:String}}""",
            parameters={"c": conn_id, "ts": tablespace}).result_rows
        objects = []
        if latest_seg and latest_seg[0][0] and latest_seg[0][0].year > 1971:
            objects = cli.query(f"""
                SELECT object_name, segment_type, round(max(size_mb), 2) AS size_mb
                FROM {CH_DB}.actmon_oracle_storage_history
                WHERE conn_id = {{c:UInt32}} AND metric_type = 'segment' AND tablespace_name = {{ts:String}}
                  AND ts >= {{at:DateTime}} - INTERVAL 10 MINUTE
                GROUP BY object_name, segment_type ORDER BY size_mb DESC LIMIT 25""",
                parameters={"c": conn_id, "ts": tablespace, "at": latest_seg[0][0]}).result_rows
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"Storage history query failed: {type(e).__name__}")
    pts = [{"t": r[0], "used_pct": r[1], "used_mb": r[2], "total_mb": r[3]} for r in trend]
    total = pts[-1]["total_mb"] if pts else None
    objs = []
    for name, stype, size in objects:
        owner, _, seg = (name or "").partition(".")
        objs.append({"owner": owner or None, "name": seg or name, "type": stype or None, "size_mb": size,
                     "pct_of_tablespace": round(100.0 * size / total, 2) if total else None})
    return {"tablespace": tablespace, "hours": hours, "bucket_s": bucket, "trend": pts, "objects": objs,
            "objects_captured_at": iso_utc(latest_seg[0][0]) if objs else None}


class CommentIn(BaseModel):
    alert_key: str = Field(..., max_length=600)
    body: str = Field(..., min_length=1, max_length=4000)


@router.get("/comments")
def list_comments(key: str = Query(..., max_length=600), db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    q = db.query(AlertComment).filter(AlertComment.alert_key == key)
    if not (claims.get("role_id") == 1 and claims.get("org_id") == 1):
        q = q.filter(AlertComment.org_id == claims.get("org_id"))
    return [{"id": c.id, "username": c.username, "body": c.body, "at": iso_utc(c.created_at)}
            for c in q.order_by(AlertComment.created_at).limit(500).all()]


@router.post("/comments")
def add_comment(req: CommentIn, db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    c = AlertComment(alert_key=req.alert_key, body=req.body.strip(), org_id=claims.get("org_id") or 1,
                     user_id=claims.get("user_id"), username=claims.get("username") or claims.get("sub") or "user")
    db.add(c)
    db.commit()
    db.refresh(c)
    return {"id": c.id, "username": c.username, "body": c.body, "at": iso_utc(c.created_at)}


@router.get("/stats")
def alert_stats(hours: int = Query(24, ge=1, le=24 * 7), db: Session = Depends(get_db), claims: dict = Depends(current_claims)):
    """Alerts page header cards + trend: collector alerts RAISED per hour (by severity) over the window, the same
    totals for the previous window (for the % change), and how many raised in the window are acknowledged.
    Rule-evaluated alerts are live state with no stored onset, so they are counted on the page from /active, not here."""
    from sqlalchemy import func as _f
    now = datetime.now(timezone.utc)
    start, prev_start = now - timedelta(hours=hours), now - timedelta(hours=2 * hours)
    q = db.query(AgentNotification)
    if not (claims.get("role_id") == 1 and claims.get("org_id") == 1):
        org = claims.get("org_id")
        names = {n for (n,) in db.query(OsServer.server_name).filter(OsServer.org_id == org).all()}
        names |= {n for (n,) in db.query(ConnectionMaster.connection_name).filter(ConnectionMaster.org_id == org).all()}
        q = q.filter(AgentNotification.agent_name.in_(list(names) or [""]))
    bucket = 3600 if hours <= 48 else 6 * 3600
    rows = (q.filter(AgentNotification.created_at >= start)
            .with_entities(_f.floor(_f.extract("epoch", AgentNotification.created_at) / bucket).label("b"),
                           _f.lower(_f.coalesce(AgentNotification.severity, "info")).label("s"), _f.count().label("n"))
            .group_by("b", "s").all())
    series = {}
    for b, s, n in rows:
        t = int(b) * bucket * 1000
        p = series.setdefault(t, {"t": t, "critical": 0, "warning": 0, "info": 0})
        p[s if s in ("critical", "warning") else "info"] += int(n)
    first = int(start.timestamp() // bucket) * bucket
    pts = [series.get(t * 1000, {"t": t * 1000, "critical": 0, "warning": 0, "info": 0}) for t in range(first, int(now.timestamp()) + 1, bucket)]
    def totals(a, b):
        out = {"critical": 0, "warning": 0, "info": 0}
        for s, n in (q.filter(AgentNotification.created_at >= a, AgentNotification.created_at < b)
                     .with_entities(_f.lower(_f.coalesce(AgentNotification.severity, "info")), _f.count())
                     .group_by(_f.lower(_f.coalesce(AgentNotification.severity, "info"))).all()):
            out[s if s in ("critical", "warning") else "info"] += int(n)
        out["total"] = sum(out.values())
        return out
    acked = q.filter(AgentNotification.created_at >= start, AgentNotification.is_read.is_(True)).count()
    acked_prev = q.filter(AgentNotification.created_at >= prev_start, AgentNotification.created_at < start, AgentNotification.is_read.is_(True)).count()
    return {"hours": hours, "bucket_s": bucket, "series": pts, "current": totals(start, now), "previous": totals(prev_start, start),
            "acknowledged": acked, "acknowledged_previous": acked_prev, "generated_at": iso_utc(now)}
