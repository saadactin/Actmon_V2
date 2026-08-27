"""
Bridges the Oracle collector cycle's already-fetched live data into the
historical ClickHouse tables (metrics_history_service.py's actmon_oracle_*
tables) — mirrors mysql_history_flush_service.py exactly. No new Oracle
queries are issued here: every function takes the SAME response object the
collector already built for the live dashboard/RAC/Services/Data-Guard/ASM
snapshots, and only decides what to persist.

Role-transition detection (switchover/failover, §11/§12) lives here too: it
compares the freshly-detected Data Guard role against ConnectionMaster.oracle_role
and writes an event to actmon_oracle_role_transitions ONLY on an actual change,
then updates the column so the next cycle compares against the new baseline.
"""
import logging
from datetime import datetime

logger = logging.getLogger("oracle_history_flush")


def _notify(db, agent_name, message, severity):
    """Same AgentNotification-write pattern _check_thresholds() already uses
    for MySQL/Postgres connection/cache-hit breaches — this is how a
    collector-detected issue reaches both the Notifications feed and (via
    alert_engine_service.infer_metric()) the Alerts page's rule matching."""
    try:
        from app.models.agent_model import AgentNotification
        db.add(AgentNotification(agent_name=agent_name, message=message, severity=severity))
        db.commit()
    except Exception as e:  # noqa: BLE001
        logger.debug("[oracle_history_flush] notify conn agent=%s: %s", agent_name, e)


def flush_rac_nodes(agent_name, conn_id, response, db):
    if not isinstance(response, dict) or not response.get("is_rac"):
        return
    nodes = response.get("nodes") or []
    if not nodes:
        return
    try:
        from app.services.clickhouse import metrics_history_service as ch
        now = datetime.now()
        rows = [{
            "ts": now, "agent": agent_name, "conn_id": conn_id,
            "instance_number": n.get("instance_number"),
            "instance_name": n.get("instance_name") or "",
            "host_name": n.get("host_name") or "",
            "instance_status": n.get("instance_status") or "",
            "database_status": n.get("database_status") or "",
            "thread_status": n.get("active_state") or "",
        } for n in nodes]
        ch.flush_oracle_rac_nodes(rows)
    except Exception as e:  # noqa: BLE001 — historical flush must never break live collection
        logger.debug("[oracle_history_flush] rac_nodes conn=%s: %s", conn_id, e)

    # Real eviction/rejoin EVENTS, not a per-cycle re-notification: compare
    # each node's status against ConnectionMaster.oracle_rac_node_status (the
    # baseline from the previous cycle), the same transition-detection idea
    # flush_dataguard() already uses for the DG role, just keyed per instance
    # instead of a single value. A node with no prior baseline just gets one
    # recorded silently — it's not treated as "just evicted" on first sight
    # (e.g. right after a deploy/restart, or the first cycle for this conn).
    try:
        from app.models.connection_model import ConnectionMaster
        conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
        if conn:
            baseline = dict(conn.oracle_rac_node_status or {})
            changed = False
            for n in nodes:
                inst = str(n.get("instance_number"))
                status = str(n.get("instance_status") or "").upper()
                prev = baseline.get(inst)
                if prev is not None and prev != status:
                    was_open, is_open = prev == "OPEN", status == "OPEN"
                    if was_open and not is_open:
                        event_type, severity = "evicted", "critical"
                        msg = (f"RAC node {inst} ({n.get('host_name') or 'unknown host'}) was evicted — "
                               f"status changed OPEN -> {status or 'unreachable'}")
                    elif not was_open and is_open:
                        event_type, severity = "rejoined", "info"
                        msg = (f"RAC node {inst} ({n.get('host_name') or 'unknown host'}) rejoined the cluster — "
                               f"status changed {prev} -> OPEN")
                    else:
                        event_type, severity = None, None
                    if event_type:
                        _notify(db, agent_name, msg, severity)
                        try:
                            from app.services.clickhouse import metrics_history_service as ch
                            ch.flush_oracle_rac_eviction_event({
                                "ts": datetime.now(), "agent": agent_name, "conn_id": conn_id,
                                "instance_number": n.get("instance_number") or 0,
                                "host_name": n.get("host_name") or "",
                                "previous_status": prev, "new_status": status,
                                "event_type": event_type,
                            })
                        except Exception as e:  # noqa: BLE001
                            logger.debug("[oracle_history_flush] rac_eviction conn=%s: %s", conn_id, e)
                if prev != status:
                    baseline[inst] = status
                    changed = True
            if changed:
                conn.oracle_rac_node_status = baseline
                db.commit()
    except Exception as e:  # noqa: BLE001
        logger.debug("[oracle_history_flush] rac_nodes baseline conn=%s: %s", conn_id, e)


def flush_services(agent_name, conn_id, response, db):
    if not isinstance(response, dict):
        return
    services = response.get("services") or []
    if not services:
        return
    try:
        from app.services.clickhouse import metrics_history_service as ch
        now = datetime.now()
        rows = []
        for svc in services:
            name = svc.get("service_name") or ""
            for inst in (svc.get("instances") or []):
                rows.append({
                    "ts": now, "agent": agent_name, "conn_id": conn_id,
                    "service_name": name,
                    "instance_number": inst.get("instance_number") or 0,
                    "status": inst.get("status") or "",
                })
        if rows:
            ch.flush_oracle_services(rows)
    except Exception as e:  # noqa: BLE001
        logger.debug("[oracle_history_flush] services conn=%s: %s", conn_id, e)

    for svc in services:
        if svc.get("status") in ("offline", "partial"):
            _notify(db, agent_name,
                    f"Oracle service {svc.get('service_name')} is {svc.get('status')}",
                    "critical" if svc.get("status") == "offline" else "warning")


def flush_dataguard(agent_name, conn_id, response, db):
    """Writes a snapshot only when Data Guard is actually configured — absence
    of rows in a window is how the report layer tells 'Standalone / Not
    Configured' apart from a real outage. Also detects and logs a role
    transition (switchover/failover) against ConnectionMaster.oracle_role."""
    if not isinstance(response, dict) or response.get("status") != "success":
        return
    role = response.get("role")
    configured = bool(response.get("configured")) or bool(role)
    if configured:
        try:
            from app.services.clickhouse import metrics_history_service as ch
            health = response.get("health") or {}
            ch.flush_oracle_dataguard_snapshot({
                "ts": datetime.now(), "agent": agent_name, "conn_id": conn_id,
                "role": role or "",
                "protection_mode": response.get("protection_mode") or "",
                "protection_level": response.get("protection_level") or "",
                "open_mode": response.get("open_mode") or "",
                "transport_status": response.get("transport_status") or "",
                "apply_status": response.get("apply_status") or "",
                "transport_lag_sec": response.get("transport_lag_sec") if response.get("transport_lag_sec") is not None else -1,
                "apply_lag_sec": response.get("apply_lag_sec") if response.get("apply_lag_sec") is not None else -1,
                "last_received_seq": response.get("last_received_seq") or 0,
                "last_applied_seq": response.get("last_applied_seq") or 0,
                "archive_gap": response.get("archive_gap") or 0,
                "last_error": (health.get("reason") or "")[:2000],
            })
        except Exception as e:  # noqa: BLE001
            logger.debug("[oracle_history_flush] dataguard conn=%s: %s", conn_id, e)

    health = response.get("health") or {}
    if health.get("status") in ("warning", "critical"):
        severity = "critical" if health.get("status") == "critical" else "warning"
        if health.get("transport") == "failed":
            _notify(db, agent_name, f"Data Guard transport failed"
                    + (f": {health.get('reason')}" if health.get("reason") else ""), severity)
        if health.get("apply") == "stopped":
            _notify(db, agent_name, "Data Guard apply (redo apply) has stopped", severity)
        if (response.get("transport_lag_sec") or 0) > 60:
            _notify(db, agent_name, f"Data Guard transport lag is {response.get('transport_lag_sec')}s", "warning")
        if (response.get("apply_lag_sec") or 0) > 60:
            _notify(db, agent_name, f"Data Guard apply lag is {response.get('apply_lag_sec')}s", "warning")
    if (response.get("archive_gap") or 0) > 0:
        _notify(db, agent_name, f"Data Guard archive gap detected ({response.get('archive_gap')} missing sequence range(s))", "critical")

    if not role:
        return
    try:
        from app.models.connection_model import ConnectionMaster
        conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
        if not conn:
            return
        previous_role = conn.oracle_role
        if previous_role and previous_role != role:
            from app.services.clickhouse import metrics_history_service as ch
            ch.flush_oracle_role_transition({
                "ts": datetime.now(), "agent": agent_name, "conn_id": conn_id,
                "previous_role": previous_role, "new_role": role,
                "reason": "Oracle Data Guard role transition detected",
            })
            logger.info("[oracle_history_flush] role transition conn=%s: %s -> %s", conn_id, previous_role, role)
            _notify(db, agent_name,
                    f"Oracle Data Guard role transition detected: {previous_role} -> {role}", "warning")
        if previous_role != role:
            conn.oracle_role = role
            db.commit()
    except Exception as e:  # noqa: BLE001
        logger.debug("[oracle_history_flush] role transition conn=%s: %s", conn_id, e)


def flush_asm(agent_name, conn_id, response, db):
    if not isinstance(response, dict) or response.get("status") != "success":
        return
    diskgroups = response.get("diskgroups") or []
    if not diskgroups:
        return
    try:
        from app.services.clickhouse import metrics_history_service as ch
        now = datetime.now()
        rows = [{
            "ts": now, "agent": agent_name, "conn_id": conn_id,
            "diskgroup_name": dg.get("name") or "",
            "state": dg.get("state") or "",
            "total_mb": int(dg.get("total_mb") or 0),
            "used_mb": int(dg.get("used_mb") or 0),
            "free_mb": int(dg.get("free_mb") or 0),
            "offline_disks": int(dg.get("offline_disks") or 0),
            "rebalance_active": 1 if dg.get("rebalance_active") else 0,
        } for dg in diskgroups]
        ch.flush_oracle_asm(rows)
    except Exception as e:  # noqa: BLE001
        logger.debug("[oracle_history_flush] asm conn=%s: %s", conn_id, e)

    for dg in diskgroups:
        if dg.get("severity") == "critical":
            _notify(db, agent_name,
                    f"ASM disk group {dg.get('name')} is critical (state={dg.get('state')}, "
                    f"offline_disks={dg.get('offline_disks')}, used={dg.get('used_pct')}%)",
                    "critical")


def flush_storage(agent_name, conn_id, response, db):
    """Takes oracle_storage_overview()'s response — one row per tablespace
    plus one per returned top segment. Notifies on tablespaces already
    flagged critical (>85% used) by oracle_tablespaces()'s own threshold;
    no new thresholds introduced here — the Phase 2 decision engine owns
    multi-factor classification."""
    if not isinstance(response, dict) or response.get("status") != "success":
        return
    tablespaces = response.get("tablespaces") or []
    segments    = response.get("top_segments") or []
    if not tablespaces and not segments:
        return
    try:
        from app.services.clickhouse import metrics_history_service as ch
        now = datetime.now()
        rows = [{
            "ts": now, "agent": agent_name, "conn_id": conn_id,
            "metric_type": "tablespace",
            "object_name": t.get("tablespace_name") or "",
            "tablespace_name": t.get("tablespace_name") or "",
            "segment_type": "",
            "size_mb": t.get("used_mb") or 0,
            "total_mb": t.get("total_mb") or 0,
            "used_pct": t.get("used_pct") or 0,
        } for t in tablespaces]
        rows += [{
            "ts": now, "agent": agent_name, "conn_id": conn_id,
            "metric_type": "segment",
            "object_name": f"{s.get('owner') or ''}.{s.get('segment_name') or ''}",
            "tablespace_name": s.get("tablespace_name") or "",
            "segment_type": s.get("segment_type") or "",
            "size_mb": s.get("size_mb") or 0,
            "total_mb": 0,
            "used_pct": 0,
        } for s in segments]
        ch.flush_oracle_storage(rows)
    except Exception as e:  # noqa: BLE001
        logger.debug("[oracle_history_flush] storage conn=%s: %s", conn_id, e)

    for t in tablespaces:
        if (t.get("used_pct") or 0) > 85:
            _notify(db, agent_name,
                    f"Tablespace {t.get('tablespace_name')} is at {t.get('used_pct')}% used "
                    f"({t.get('used_mb')}MB / {t.get('total_mb')}MB)",
                    "critical")
