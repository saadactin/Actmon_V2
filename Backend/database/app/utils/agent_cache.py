"""
Agent Cache Utility
===================
Routes call get_snapshot() first. If a fresh snapshot exists the caller
returns it directly — the monitored database is never touched.
The agent collector is the only code that ever opens a connection to the
monitored database and populates these snapshots.
"""

import json
import datetime
import logging
import threading

from sqlalchemy.orm import Session

logger = logging.getLogger("agent_cache")

# The collector thread sets this to True so route-handler cache checks return
# None (forcing a fresh DB query) when called from the collector context.
_bypass_cache = threading.local()

# How long stored telemetry is served (minutes). This is the "last-known, always
# shown" window: the dashboard reads the latest stored snapshot instantly and the
# collector refreshes it every 60s in the background — so opening a dashboard never
# blocks on a live agent query. Generous (3h) so agent hiccups / brief outages never
# blank the dashboard; a fresh successful collection always replaces it.
SNAPSHOT_TTL_MINUTES = 180


def get_snapshot(connection_id: int, snapshot_type: str, db: Session):
    """Return the cached payload dict if an online agent has a fresh snapshot.
    Returns None if no agent exists, agent is offline, snapshot is stale,
    or the caller is the collector thread (which always fetches fresh data).
    """
    if getattr(_bypass_cache, "active", False):
        return None  # collector thread always queries the DB directly
    try:
        from app.models.agent_model import AgentSnapshot

        # Serve the freshest snapshot for THIS connection, regardless of the agent's
        # momentary status. A snapshot < TTL old is still valid data — the dashboard
        # must not blank out just because the agent missed a heartbeat.
        cutoff = datetime.datetime.utcnow() - datetime.timedelta(minutes=SNAPSHOT_TTL_MINUTES)
        snap = (
            db.query(AgentSnapshot)
            .filter(
                AgentSnapshot.connection_id == connection_id,
                AgentSnapshot.snapshot_type == snapshot_type,
                AgentSnapshot.captured_at >= cutoff,
            )
            .order_by(AgentSnapshot.captured_at.desc())
            .first()
        )
        if snap:
            return json.loads(snap.payload)
        return None

    except Exception as exc:
        logger.debug(f"[agent_cache] get_snapshot failed ({snapshot_type}): {exc}")
        return None


def store_snapshot(agent_name: str, connection_id: int,
                   snapshot_type: str, payload: dict, db: Session):
    """Persist a snapshot. Replaces any existing snapshot of the same type."""
    try:
        from app.models.agent_model import AgentSnapshot

        existing = (
            db.query(AgentSnapshot)
            .filter(
                AgentSnapshot.agent_name == agent_name,
                AgentSnapshot.snapshot_type == snapshot_type,
            )
            .first()
        )
        serialized = json.dumps(payload, default=str)
        if existing:
            existing.payload = serialized
            existing.captured_at = datetime.datetime.utcnow()
        else:
            db.add(AgentSnapshot(
                agent_name=agent_name,
                connection_id=connection_id,
                snapshot_type=snapshot_type,
                payload=serialized,
            ))
        # Stable-facts pipeline: versions/database-lists/config limits are stored once
        # (PostgreSQL) and re-written only when they CHANGE; drift goes to the change log.
        # Runs on its OWN session — a stable-store failure must never roll back the
        # snapshot pending on this session.
        try:
            from app.services.common import metrics_pipeline
            metrics_pipeline.stable_from_snapshot(agent_name, connection_id, snapshot_type, payload)
        except Exception:  # noqa: BLE001 — never let telemetry break the cache write
            pass
    except Exception as exc:
        logger.error(f"[agent_cache] store_snapshot failed ({snapshot_type}): {exc}")


def store_snapshot_for_conn(connection_id: int, snapshot_type: str, payload: dict, db: Session):
    """Cache a snapshot keyed to the agent linked to this connection, and COMMIT.
    Lets a successful live dashboard build populate the cache itself — so the dashboard
    stays visible for the TTL even if the collector's next build fails (agent busy)."""
    try:
        from app.models.agent_model import Agent
        agent = (
            db.query(Agent)
            .filter(Agent.db_connection_id == connection_id)
            .order_by(Agent.status.desc())   # prefer an 'online' row if several
            .first()
        )
        name = agent.agent_name if agent else f"conn-{connection_id}"
        store_snapshot(name, connection_id, snapshot_type, payload, db)
        db.commit()
    except Exception as exc:
        logger.debug(f"[agent_cache] store_snapshot_for_conn failed ({snapshot_type}): {exc}")
        try: db.rollback()
        except Exception: pass
