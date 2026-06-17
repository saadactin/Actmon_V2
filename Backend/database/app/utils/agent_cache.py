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

# How long a snapshot stays valid (minutes)
SNAPSHOT_TTL_MINUTES = 5


def get_snapshot(connection_id: int, snapshot_type: str, db: Session):
    """Return the cached payload dict if an online agent has a fresh snapshot.
    Returns None if no agent exists, agent is offline, snapshot is stale,
    or the caller is the collector thread (which always fetches fresh data).
    """
    if getattr(_bypass_cache, "active", False):
        return None  # collector thread always queries the DB directly
    try:
        from app.models.agent_model import Agent, AgentSnapshot

        agent = (
            db.query(Agent)
            .filter(
                Agent.db_connection_id == connection_id,
                Agent.status == "online",
            )
            .first()
        )
        if not agent:
            return None

        cutoff = datetime.datetime.utcnow() - datetime.timedelta(minutes=SNAPSHOT_TTL_MINUTES)
        snap = (
            db.query(AgentSnapshot)
            .filter(
                AgentSnapshot.agent_name == agent.agent_name,
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
    except Exception as exc:
        logger.error(f"[agent_cache] store_snapshot failed ({snapshot_type}): {exc}")
