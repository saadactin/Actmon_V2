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

import csv
import io
import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import desc

from app.database.connection import SessionLocal
from app.models.agent_model import (
    Agent,
    AgentMetric,
    AgentTopSQL,
    AgentWaitEvent,
    AgentNotification,
    AgentOracleSnapshot,
)
from app.models.connection_model import ConnectionMaster

router = APIRouter(prefix="/api/v1/agents", tags=["Agents"])


# ─────────────────────────────────────────────────────────────
# DB dependency
# ─────────────────────────────────────────────────────────────

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ─────────────────────────────────────────────────────────────
# Pydantic request/response models
# ─────────────────────────────────────────────────────────────

class AgentRegisterRequest(BaseModel):
    agent_name: str
    db_connection_id: Optional[int] = None
    db_type: str = "MySQL"
    hostname: Optional[str] = None
    ip_address: Optional[str] = None
    os_type: Optional[str] = None
    description: Optional[str] = None
    environment: str = "Production"
    collection_interval_sec: int = 60


class MetricIngest(BaseModel):
    host_cpu: float = 0.0
    host_memory: float = 0.0
    db_cpu: float = 0.0
    active_sessions: int = 0
    connections_used: int = 0
    connections_max: int = 100
    cache_hit_pct: float = 100.0
    qps: float = 0.0
    tps: float = 0.0
    uptime_seconds: int = 0


class SQLIngest(BaseModel):
    sql_id: Optional[str] = None
    sql_text: Optional[str] = None
    executions: int = 0
    avg_elapsed_ms: float = 0.0
    cpu_time_ms: float = 0.0
    buffer_gets: int = 0
    total_ms: float = 0.0
    max_ms: float = 0.0
    rows_examined: float = 0.0
    rows_sent: float = 0.0


class WaitEventIngest(BaseModel):
    event_name: str
    wait_class: Optional[str] = None
    time_waited_ms: float = 0.0
    avg_ms: float = 0.0
    count: int = 0


class OracleSnapshotIngest(BaseModel):
    version: Optional[str] = None
    instance_name: Optional[str] = None
    startup_time: Optional[str] = None
    sga_size_bytes: int = 0
    pga_size_bytes: int = 0
    log_mode: Optional[str] = None
    archiver: Optional[str] = None
    status: Optional[str] = None
    open_mode: Optional[str] = None
    database_status: Optional[str] = None
    instance_role: Optional[str] = None


class AgentDataIngest(BaseModel):
    """Payload pushed by an external lightweight agent or internal collector."""
    agent_name: str
    metrics: MetricIngest
    top_sql: Optional[List[SQLIngest]] = []
    wait_events: Optional[List[WaitEventIngest]] = []
    oracle_snapshot: Optional[OracleSnapshotIngest] = None


class NotificationReadRequest(BaseModel):
    ids: List[int]


# ─────────────────────────────────────────────────────────────
# POST /register  — register a new agent
# ─────────────────────────────────────────────────────────────

@router.post("/register", summary="Register a new monitoring agent")
def register_agent(req: AgentRegisterRequest, db: Session = Depends(get_db)):
    existing = db.query(Agent).filter(Agent.agent_name == req.agent_name).first()
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"Agent '{req.agent_name}' is already registered.",
        )

    hostname = req.hostname
    ip_address = req.ip_address
    if req.db_connection_id and (not hostname or not ip_address):
        conn_rec = db.query(ConnectionMaster).filter(
            ConnectionMaster.id == req.db_connection_id
        ).first()
        if conn_rec:
            hostname = hostname or conn_rec.host
            ip_address = ip_address or conn_rec.host

    agent = Agent(
        agent_name=req.agent_name,
        db_connection_id=req.db_connection_id,
        db_type=req.db_type,
        hostname=hostname,
        ip_address=ip_address,
        os_type=req.os_type,
        description=req.description,
        environment=req.environment,
        status="offline",
        collection_interval_sec=req.collection_interval_sec,
    )
    db.add(agent)
    db.commit()
    db.refresh(agent)
    return {"status": "success", "agent_name": agent.agent_name, "id": agent.id}


# ─────────────────────────────────────────────────────────────
# POST /sync-connections — auto-create agents from ConnectionMaster
# ─────────────────────────────────────────────────────────────

@router.post("/sync-connections", summary="Auto-create agents from saved DB connections")
def sync_connections_to_agents(db: Session = Depends(get_db)):
    connections = db.query(ConnectionMaster).all()
    created, skipped = [], []
    for c in connections:
        name = c.connection_name or f"{c.db_type}-{c.id}"
        try:
            # Re-query inside loop so we see agents created earlier in this run
            if db.query(Agent).filter(Agent.agent_name == name).first():
                skipped.append(name)
                continue
            db_type = (c.db_type or "mysql").lower()
            display_type = {
                "mysql": "MySQL", "postgresql": "PostgreSQL", "postgres": "PostgreSQL",
                "oracle": "Oracle", "mssql": "MSSQL",
                "mongodb": "MongoDB", "clickhouse": "ClickHouse",
            }.get(db_type, (c.db_type or "MySQL").capitalize())
            db.add(Agent(
                agent_name=name,
                db_connection_id=c.id,
                db_type=display_type,
                hostname=c.host,
                ip_address=c.host,
                environment=c.environment or "Production",
                status="offline",
            ))
            # Commit per agent so a duplicate on one never rolls back the others
            db.commit()
            created.append(name)
        except Exception:
            db.rollback()
            skipped.append(name)
    return {"status": "success", "created": created, "skipped": skipped}


# ─────────────────────────────────────────────────────────────
# POST /data  — ingest metrics from an external agent script
# ─────────────────────────────────────────────────────────────

@router.post("/data", summary="Agent data ingest")
def ingest_agent_data(payload: AgentDataIngest, db: Session = Depends(get_db)):
    agent = db.query(Agent).filter(Agent.agent_name == payload.agent_name).first()
    if not agent:
        raise HTTPException(
            status_code=404,
            detail=f"Agent '{payload.agent_name}' not found. Register first via POST /register.",
        )

    m = payload.metrics
    db.add(AgentMetric(
        agent_name=payload.agent_name,
        host_cpu=m.host_cpu,
        host_memory=m.host_memory,
        db_cpu=m.db_cpu,
        active_sessions=m.active_sessions,
        connections_used=m.connections_used,
        connections_max=m.connections_max,
        cache_hit_pct=m.cache_hit_pct,
        qps=m.qps,
        tps=m.tps,
        uptime_seconds=m.uptime_seconds,
    ))

    for s in (payload.top_sql or []):
        db.add(AgentTopSQL(
            agent_name=payload.agent_name,
            sql_id=s.sql_id,
            sql_text=(s.sql_text or "")[:2000],
            executions=s.executions,
            avg_elapsed_ms=s.avg_elapsed_ms,
            cpu_time_ms=s.cpu_time_ms,
            buffer_gets=s.buffer_gets,
            total_ms=s.total_ms,
            max_ms=s.max_ms,
            rows_examined=s.rows_examined,
            rows_sent=s.rows_sent,
        ))

    for w in (payload.wait_events or []):
        db.add(AgentWaitEvent(
            agent_name=payload.agent_name,
            event_name=w.event_name,
            wait_class=w.wait_class,
            time_waited_ms=w.time_waited_ms,
            avg_ms=w.avg_ms,
            count=w.count,
        ))

    if payload.oracle_snapshot:
        os_snap = payload.oracle_snapshot
        db.add(AgentOracleSnapshot(
            agent_name=payload.agent_name,
            version=os_snap.version,
            instance_name=os_snap.instance_name,
            startup_time=os_snap.startup_time,
            sga_size_bytes=os_snap.sga_size_bytes,
            pga_size_bytes=os_snap.pga_size_bytes,
            log_mode=os_snap.log_mode,
            archiver=os_snap.archiver,
            status=os_snap.status,
            open_mode=os_snap.open_mode,
            database_status=os_snap.database_status,
            instance_role=os_snap.instance_role,
        ))

    agent.status = "online"
    agent.last_heartbeat = datetime.datetime.utcnow()
    db.commit()
    return {"status": "success", "agent_name": payload.agent_name}


# ─────────────────────────────────────────────────────────────
# GET /  — list all registered agents
# ─────────────────────────────────────────────────────────────

@router.get("/", summary="List all accessible agents")
def list_agents(db: Session = Depends(get_db)):
    agents = db.query(Agent).order_by(Agent.agent_name).all()
    result = []
    for a in agents:
        latest = (
            db.query(AgentMetric)
            .filter(AgentMetric.agent_name == a.agent_name)
            .order_by(desc(AgentMetric.timestamp))
            .first()
        )
        result.append({
            "name": a.agent_name,
            "db_type": a.db_type or "MySQL",
            "hostname": a.hostname or "",
            "ip_address": a.ip_address or "",
            "os_type": a.os_type or "",
            "environment": a.environment or "Production",
            "status": a.status or "offline",
            "cpu_usage": latest.host_cpu if latest else 0.0,
            "memory_usage": latest.host_memory if latest else 0.0,
            "db_cpu": latest.db_cpu if latest else 0.0,
            "active_sessions": latest.active_sessions if latest else 0,
            "last_heartbeat": (
                a.last_heartbeat.isoformat() if a.last_heartbeat else None
            ),
            "created_at": a.created_at.isoformat() if a.created_at else None,
            "description": a.description or "",
            "db_connection_id": a.db_connection_id,
            "has_connection": a.db_connection_id is not None,
            "collection_interval_sec": a.collection_interval_sec or 60,
        })
    return result


# ─────────────────────────────────────────────────────────────
# Notifications — MUST be declared before /{agent_name}/...
# to prevent 'notifications' being matched as an agent_name
# ─────────────────────────────────────────────────────────────

@router.get("/notifications/", summary="Get unread notifications")
def get_notifications(
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(AgentNotification)
        .filter(AgentNotification.is_read.is_(False))
        .order_by(desc(AgentNotification.created_at))
        .limit(limit)
        .all()
    )
    return [
        {
            "id": n.id,
            "agent_name": n.agent_name,
            "message": n.message,
            "severity": n.severity,
            "is_read": n.is_read,
            "created_at": n.created_at.isoformat() if n.created_at else None,
        }
        for n in rows
    ]


@router.post("/notifications/read", summary="Mark notifications as read")
def mark_notifications_read(
    payload: NotificationReadRequest,
    db: Session = Depends(get_db),
):
    if payload.ids:
        db.query(AgentNotification).filter(
            AgentNotification.id.in_(payload.ids)
        ).update({"is_read": True}, synchronize_session=False)
        db.commit()
    return {"status": "success", "marked": len(payload.ids)}


# ─────────────────────────────────────────────────────────────
# GET /{agent_name}/dashboard  — single-agent dashboard data
# ─────────────────────────────────────────────────────────────

@router.get("/{agent_name}/dashboard", summary="Single-agent dashboard data")
def get_agent_dashboard(
    agent_name: str,
    hours: int = Query(6, ge=1, le=720),
    db: Session = Depends(get_db),
):
    agent = db.query(Agent).filter(Agent.agent_name == agent_name).first()
    if not agent:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found.")

    latest = (
        db.query(AgentMetric)
        .filter(AgentMetric.agent_name == agent_name)
        .order_by(desc(AgentMetric.timestamp))
        .first()
    )

    return {
        "agent_name": agent.agent_name,
        "db_type": agent.db_type or "MySQL",
        "status": agent.status or "offline",
        "hostname": agent.hostname or "",
        "ip_address": agent.ip_address or "",
        "os_type": agent.os_type or "",
        "environment": agent.environment or "Production",
        "description": agent.description or "",
        "last_heartbeat": (
            agent.last_heartbeat.isoformat() if agent.last_heartbeat else None
        ),
        "metrics": {
            "host_cpu": latest.host_cpu if latest else 0.0,
            "host_memory": latest.host_memory if latest else 0.0,
            "db_cpu": latest.db_cpu if latest else 0.0,
            "active_sessions": latest.active_sessions if latest else 0,
            "connections_used": latest.connections_used if latest else 0,
            "connections_max": latest.connections_max if latest else 0,
            "cache_hit_pct": latest.cache_hit_pct if latest else 0.0,
            "qps": latest.qps if latest else 0.0,
            "tps": latest.tps if latest else 0.0,
            "uptime_seconds": latest.uptime_seconds if latest else 0,
        },
    }


# ─────────────────────────────────────────────────────────────
# GET /{agent_name}/metrics  — time-series chart data
# ─────────────────────────────────────────────────────────────

@router.get("/{agent_name}/metrics", summary="Metric chart drilldown")
def get_agent_metrics(
    agent_name: str,
    hours: int = Query(24, ge=1, le=720),
    db: Session = Depends(get_db),
):
    agent = db.query(Agent).filter(Agent.agent_name == agent_name).first()
    if not agent:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found.")

    since = datetime.datetime.utcnow() - datetime.timedelta(hours=hours)
    rows = (
        db.query(AgentMetric)
        .filter(
            AgentMetric.agent_name == agent_name,
            AgentMetric.timestamp >= since,
        )
        .order_by(AgentMetric.timestamp)
        .all()
    )
    return [
        {
            "timestamp": r.timestamp.isoformat() if r.timestamp else None,
            "host_cpu": r.host_cpu,
            "host_memory": r.host_memory,
            "db_cpu": r.db_cpu,
            "active_sessions": r.active_sessions,
            "connections_used": r.connections_used,
            "cache_hit_pct": r.cache_hit_pct,
            "qps": r.qps,
            "tps": r.tps,
        }
        for r in rows
    ]


# ─────────────────────────────────────────────────────────────
# GET /{agent_name}/sql  — top SQL performance drilldown
# ─────────────────────────────────────────────────────────────

@router.get("/{agent_name}/sql", summary="SQL performance drilldown")
def get_agent_sql(
    agent_name: str,
    hours: int = Query(6, ge=1, le=720),
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
):
    agent = db.query(Agent).filter(Agent.agent_name == agent_name).first()
    if not agent:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found.")

    since = datetime.datetime.utcnow() - datetime.timedelta(hours=hours)
    rows = (
        db.query(AgentTopSQL)
        .filter(
            AgentTopSQL.agent_name == agent_name,
            AgentTopSQL.captured_at >= since,
        )
        .order_by(desc(AgentTopSQL.total_ms))
        .limit(limit)
        .all()
    )
    return [
        {
            "sql_id": r.sql_id or "",
            "sql_text": r.sql_text or "",
            "executions": r.executions,
            "avg_elapsed_ms": r.avg_elapsed_ms,
            "cpu_time_ms": r.cpu_time_ms,
            "buffer_gets": r.buffer_gets,
            "total_ms": r.total_ms,
            "max_ms": r.max_ms,
            "rows_examined": r.rows_examined,
            "captured_at": r.captured_at.isoformat() if r.captured_at else None,
        }
        for r in rows
    ]


# ─────────────────────────────────────────────────────────────
# GET /{agent_name}/wait-events  — wait event drilldown
# ─────────────────────────────────────────────────────────────

@router.get("/{agent_name}/wait-events", summary="Wait event drilldown")
def get_agent_wait_events(
    agent_name: str,
    hours: int = Query(6, ge=1, le=720),
    db: Session = Depends(get_db),
):
    agent = db.query(Agent).filter(Agent.agent_name == agent_name).first()
    if not agent:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found.")

    since = datetime.datetime.utcnow() - datetime.timedelta(hours=hours)
    rows = (
        db.query(AgentWaitEvent)
        .filter(
            AgentWaitEvent.agent_name == agent_name,
            AgentWaitEvent.captured_at >= since,
        )
        .order_by(desc(AgentWaitEvent.time_waited_ms))
        .limit(50)
        .all()
    )
    return [
        {
            "event_name": r.event_name or "",
            "wait_class": r.wait_class or "",
            "time_waited_ms": r.time_waited_ms,
            "avg_ms": r.avg_ms,
            "count": r.count,
            "captured_at": r.captured_at.isoformat() if r.captured_at else None,
        }
        for r in rows
    ]


# ─────────────────────────────────────────────────────────────
# GET /{agent_name}/oracle-snapshot  — latest Oracle DB snapshot
# ─────────────────────────────────────────────────────────────

@router.get("/{agent_name}/oracle-snapshot", summary="Latest Oracle DB snapshot")
def get_oracle_snapshot(agent_name: str, db: Session = Depends(get_db)):
    agent = db.query(Agent).filter(Agent.agent_name == agent_name).first()
    if not agent:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found.")

    snap = (
        db.query(AgentOracleSnapshot)
        .filter(AgentOracleSnapshot.agent_name == agent_name)
        .order_by(desc(AgentOracleSnapshot.captured_at))
        .first()
    )
    if not snap:
        raise HTTPException(
            status_code=404,
            detail="No Oracle snapshot available. Ensure the agent is online and collecting.",
        )

    return {
        "version": snap.version or "",
        "instance_name": snap.instance_name or "",
        "startup_time": snap.startup_time or "",
        "sga_size_bytes": snap.sga_size_bytes,
        "pga_size_bytes": snap.pga_size_bytes,
        "log_mode": snap.log_mode or "",
        "archiver": snap.archiver or "",
        "status": snap.status or "",
        "open_mode": snap.open_mode or "",
        "database_status": snap.database_status or "",
        "instance_role": snap.instance_role or "",
        "captured_at": snap.captured_at.isoformat() if snap.captured_at else None,
    }


# ─────────────────────────────────────────────────────────────
# GET /{agent_name}/export/csv  — export metrics as CSV
# ─────────────────────────────────────────────────────────────

@router.get("/{agent_name}/export/csv", summary="Export agent metrics as CSV")
def export_metrics_csv(
    agent_name: str,
    hours: int = Query(24, ge=1, le=720),
    db: Session = Depends(get_db),
):
    agent = db.query(Agent).filter(Agent.agent_name == agent_name).first()
    if not agent:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_name}' not found.")

    since = datetime.datetime.utcnow() - datetime.timedelta(hours=hours)
    rows = (
        db.query(AgentMetric)
        .filter(
            AgentMetric.agent_name == agent_name,
            AgentMetric.timestamp >= since,
        )
        .order_by(AgentMetric.timestamp)
        .all()
    )

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "timestamp", "host_cpu_pct", "host_memory_pct", "db_cpu_pct",
        "active_sessions", "connections_used", "connections_max",
        "cache_hit_pct", "qps", "tps", "uptime_seconds",
    ])
    for r in rows:
        writer.writerow([
            r.timestamp.isoformat() if r.timestamp else "",
            r.host_cpu, r.host_memory, r.db_cpu,
            r.active_sessions, r.connections_used, r.connections_max,
            r.cache_hit_pct, r.qps, r.tps, r.uptime_seconds,
        ])

    output.seek(0)
    filename = f"{agent_name}_metrics_{hours}h.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
