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
    svc_get_agent_sessions,
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


@router.get("/{agent_name}/sessions", summary="Live DB connections/sessions")
def route_get_agent_sessions(agent_name: str, db: Session = Depends(get_db)):
    return svc_get_agent_sessions(agent_name, db)


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




def _comm_stats(agent, ring, ch_today, pending):
    """Agent COMMUNICATION performance, derived from the live sample stream:
    actual delivery rate vs expected, inter-arrival latency/jitter, throughput,
    endpoints in use — everything the Agent-Monitoring page charts."""
    import json as _json
    interval = agent.collection_interval_sec or 15
    ts_list = [s.get("ts") for s in ring if s.get("ts")]
    gaps = [ts_list[i] - ts_list[i + 1] for i in range(len(ts_list) - 1)] if len(ts_list) > 1 else []
    avg_gap = (sum(gaps) / len(gaps)) if gaps else None
    jitter = (max(gaps) - min(gaps)) if gaps else None
    span_h = ((ts_list[0] - ts_list[-1]) / 3600.0) if len(ts_list) > 1 else 0
    expected = int(span_h * 3600 / interval) if span_h > 0 else len(ring)
    delivery_pct = round(min(100.0, (len(ring) / expected) * 100), 1) if expected else 100.0
    sample_bytes = len(_json.dumps(ring[0])) if ring else 0
    import time as _t
    last_age = (_t.time() - ts_list[0]) if ts_list else None
    return {
        "live_samples_1h": len(ring),
        "latest": ring[0] if ring else None,
        "ring": ring,                                   # full hour for the big charts
        "clickhouse": ch_today,
        "pending_ch_queue": pending,
        "comm": {
            "expected_samples": expected,
            "delivery_pct": delivery_pct,               # packet delivery status
            "avg_interval_s": round(avg_gap, 1) if avg_gap else None,
            "jitter_s": round(jitter, 1) if jitter is not None else None,
            "last_sample_age_s": round(last_age, 1) if last_age is not None else None,
            "incoming_rate_per_min": round(len(ring) / max(span_h * 60, 1), 2) if span_h else None,
            "sample_size_bytes": sample_bytes,
            "throughput_bytes_per_min": round(sample_bytes * (len(ring) / max(span_h * 60, 1)), 0) if span_h else None,
            "endpoints": ["/api/v1/agents/infra (push, every %ss)" % interval,
                          "/api/v1/agents/data (DB metrics push)",
                          "/api/v1/agents/fs-poll (job long-poll, 12s hold)",
                          "/api/v1/agents/collector/{os} (collector refresh)"],
        },
        "transport": {"redis": bool(ring), "server_reachable": True},
    }


@router.get("/{agent_name}/host-overview", summary="Dedicated HOST-agent monitoring view (one call)")
def host_overview(agent_name: str, db: Session = Depends(get_db)):
    """Everything the Host-Agent page needs: agent health/heartbeat, telemetry flow
    stats (Redis ring + ClickHouse counts), host resources (CPU/RAM/disk/net from the
    agent's last infra push), top processes, and recent agent events."""
    import json as _json
    from app.models.agent_model import Agent, AgentNotification
    from app.models.os_server_model import OsServer

    agent = db.query(Agent).filter(Agent.agent_name == agent_name).first()
    if not agent:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Agent not found")

    server = db.query(OsServer).filter(OsServer.server_name == agent_name).first()
    infra = {}
    if server and server.last_infra_json:
        try:
            infra = _json.loads(server.last_infra_json)
        except Exception:  # noqa: BLE001
            infra = {}

    # Telemetry flow: live ring from Redis + today's row count from ClickHouse.
    ring, ch_today, pending = [], None, 0
    try:
        from app.services.redis import redis_store_service as _rs
        ring = _rs.live(agent_name, limit=240)
        pending = _rs.pending_depth()
    except Exception:  # noqa: BLE001
        pass
    try:
        from app.services.clickhouse import metrics_history_service as _mh
        cli = _mh.get_client()
        if cli:
            r = cli.query("SELECT count(), max(ts) FROM actmon.metrics_infra "
                          "WHERE agent = %(a)s AND ts > now() - INTERVAL 1 DAY",
                          parameters={"a": agent_name})
            if r.result_rows:
                ch_today = {"rows_24h": r.result_rows[0][0],
                            "last_ts": str(r.result_rows[0][1])}
    except Exception:  # noqa: BLE001
        pass

    events = [{"ts": str(n.created_at), "message": n.message, "severity": n.severity}
              for n in db.query(AgentNotification)
                        .filter(AgentNotification.agent_name == agent_name)
                        .order_by(AgentNotification.created_at.desc()).limit(20).all()]

    mem = infra.get("memory") or {}
    fs = infra.get("filesystems") or []
    return {
        "agent": {
            "name": agent.agent_name, "hostname": agent.hostname, "ip": agent.ip_address,
            "os_type": agent.os_type, "status": agent.status, "environment": agent.environment,
            "last_heartbeat": str(agent.last_heartbeat) if agent.last_heartbeat else None,
            "created_at": str(agent.created_at) if agent.created_at else None,
            "collection_interval_sec": agent.collection_interval_sec or 15,
        },
        "telemetry": _comm_stats(agent, ring, ch_today, pending),
        "host": {
            "cpu_pct": infra.get("cpu_pct"),
            "load": infra.get("load"),
            "memory": {"total_mb": mem.get("total_mb"), "used_mb": mem.get("used_mb"),
                       "used_pct": mem.get("used_pct")},
            "filesystems": fs[:8],
            "network": (infra.get("interfaces") or infra.get("network") or [])[:8],
            "uptime": infra.get("uptime"),
            "os": infra.get("os") or infra.get("os_version"),
            "processes_top": (infra.get("processes") or [])[:10],
            "services_count": len(infra.get("services") or []),
            "ports_count": len(infra.get("ports") or []),
        },
        "events": events,
    }
