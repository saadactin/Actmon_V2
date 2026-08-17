"""
Bridges the Patroni collector cycle's already-fetched status into the
historical ClickHouse tables (metrics_history_service.py's
actmon_postgres_patroni_* tables) — mirrors oracle_history_flush_service.py.
No new Patroni/Postgres queries here: takes the SAME svc_patroni_status()
response the collector already builds for the live snapshot.

Leader-transition detection keeps its "last known leader" in a simple
process-level dict rather than a new persisted column — the same lightweight
pattern metrics_history_service.py itself already uses for its own
_db_ready/_tables_ready state. A missed transition across a backend restart is
a cosmetic gap in the historical event log only; the live status shown on the
page is always recomputed fresh from Patroni's own REST API regardless.
"""
import logging
from datetime import datetime

logger = logging.getLogger("postgres_patroni_history_flush")

_last_known_leader: dict[int, str] = {}


def _notify(db, agent_name, message, severity):
    try:
        from app.models.agent_model import AgentNotification
        db.add(AgentNotification(agent_name=agent_name, message=message, severity=severity))
        db.commit()
    except Exception as e:  # noqa: BLE001
        logger.debug("[postgres_patroni_history_flush] notify agent=%s: %s", agent_name, e)


def flush_patroni_status(agent_name: str, conn_id: int, response: dict, db):
    if not isinstance(response, dict) or not response.get("patroni_detected"):
        return
    members = response.get("members") or []
    if not members:
        return

    try:
        from app.services.clickhouse import metrics_history_service as ch
        now = datetime.now()
        rows = [{
            "ts": now, "agent": agent_name, "conn_id": conn_id,
            "member_name": m.get("member_name") or "",
            "role": m.get("role") or "",
            "state": m.get("patroni_state") or "",
            "timeline": m.get("timeline") or 0,
            "receive_lag": m.get("receive_lag") if isinstance(m.get("receive_lag"), int) else 0,
            "replay_lag": m.get("replay_lag") if isinstance(m.get("replay_lag"), int) else 0,
            "patroni_state": m.get("node_health") or "",
        } for m in members]
        ch.flush_postgres_patroni_members(rows)
    except Exception as e:  # noqa: BLE001 — historical flush must never break live collection
        logger.debug("[postgres_patroni_history_flush] members conn=%s: %s", conn_id, e)

    for m in members:
        if m.get("node_health") == "DEGRADED":
            _notify(db, agent_name,
                    f"Patroni member {m.get('member_name')} ({m.get('server_name') or m.get('ip_address')}) "
                    f"is DEGRADED — state={m.get('patroni_state')}",
                    "critical")
        elif m.get("node_health") == "WARNING":
            _notify(db, agent_name,
                    f"Patroni member {m.get('member_name')} has a replication issue "
                    f"(WAL receiver not streaming or lagging)",
                    "warning")

    leader = response.get("leader")
    if not leader:
        return
    previous = _last_known_leader.get(conn_id)
    if previous and previous != leader:
        try:
            from app.services.clickhouse import metrics_history_service as ch
            ch.flush_postgres_patroni_transition({
                "ts": datetime.now(), "agent": agent_name, "conn_id": conn_id,
                "event_type": "leader_change", "previous_leader": previous,
                "new_leader": leader, "reason": "Patroni leader change detected",
            })
            logger.info("[postgres_patroni_history_flush] leader change conn=%s: %s -> %s",
                        conn_id, previous, leader)
            _notify(db, agent_name,
                    f"Patroni leader change detected: {previous} -> {leader}", "warning")
        except Exception as e:  # noqa: BLE001
            logger.debug("[postgres_patroni_history_flush] transition conn=%s: %s", conn_id, e)
    _last_known_leader[conn_id] = leader
