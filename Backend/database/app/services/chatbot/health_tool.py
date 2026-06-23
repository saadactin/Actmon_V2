"""
ActMon AI — live data tools.

Lets the chatbot answer questions like "give me xyz node's DB health report today"
by detecting the target connection in the message and pulling its REAL-TIME
dashboard/health data (per DB engine), so the assistant reports actual numbers
instead of emitting SQL.
"""
import re

from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster

_HEALTH_WORDS = (
    "health", "status", "report", "how is", "how's", "overview", "performance",
    "metric", "utiliz", "slow", "connection", "uptime", "cache", "doing",
    "check", "summary", "monitor", "load", "cpu", "memory", "ram", "disk",
)


def detect_health_intent(text: str) -> bool:
    t = (text or "").lower()
    return any(w in t for w in _HEALTH_WORDS)


def find_connection(db: Session, text: str, org_id=None):
    """Best-effort match of a connection referenced in the message (by name, host or db)."""
    q = db.query(ConnectionMaster)
    if org_id is not None:
        q = q.filter(ConnectionMaster.org_id == org_id)
    conns = q.all()
    t = (text or "").lower()

    # 1) exact connection-name substring
    for c in conns:
        if c.connection_name and c.connection_name.lower() in t:
            return c
    # 2) host or database name substring
    for c in conns:
        if (c.host and c.host.lower() in t) or (c.database_name and c.database_name.lower() in t):
            return c
    # 3) any meaningful token of the connection name appears in the message
    for c in conns:
        for tok in re.split(r"[^a-z0-9]+", (c.connection_name or "").lower()):
            if len(tok) >= 3 and tok in t:
                return c
    return None


def get_live_health(db: Session, conn) -> dict:
    """Dispatch to the right engine's live dashboard service."""
    dbt = (conn.db_type or "").lower()
    try:
        if dbt in ("mysql", "mariadb"):
            from app.services.mysql.mysql_dashboard_service import get_dashboard
            return get_dashboard(conn.id, db, live=True)
        if dbt == "postgresql":
            from app.services.postgres.postgres_connection_service import svc_get_dashboard
            return svc_get_dashboard(conn.id, db)
        if dbt == "oracle":
            from app.services.oracle.oracle_monitoring_service import oracle_dashboard
            return oracle_dashboard(conn.id, db)
        if dbt == "mssql":
            from app.services.mssql.mssql_monitoring_service import get_monitoring_dashboard
            return get_monitoring_dashboard(conn.id, db)
        if dbt == "mongodb":
            from app.services.mongo.mongo_monitoring_service import get_dashboard
            return get_dashboard(conn.id, db)
        if dbt == "clickhouse":
            from app.services.clickhouse.clickhouse_monitoring_service import get_dashboard
            return get_dashboard(conn.id, db)
    except Exception as e:
        return {"error": f"Could not fetch live data: {e}"}
    return {"error": f"No live dashboard available for {dbt}."}


def compact(data):
    """Trim big arrays so the snapshot stays small for the LLM but keeps every scalar metric."""
    if not isinstance(data, dict):
        return data
    out = {}
    for k, v in data.items():
        if isinstance(v, list):
            out[k] = v if len(v) <= 3 else f"[{len(v)} items]"
        elif isinstance(v, dict):
            out[k] = {kk: (f"[{len(vv)} items]" if isinstance(vv, list) and len(vv) > 3 else vv)
                      for kk, vv in v.items()}
        else:
            out[k] = v
    return out
