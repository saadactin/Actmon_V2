"""
Make every RAC node a first-class host on the servers page.

The servers page groups by `cluster_name` and anything whose `node_type` is not
'Standalone'. Until now an Oracle RAC appeared as one standalone host — the node
the agent happens to sit on — and its siblings did not appear at all, which is
a misleading picture of a two-node cluster.

This syncs an OsServer row per RAC node from GV$INSTANCE plus the host metrics
oracle_rac_host_service already collects. It follows the precedent agent
enrollment set in infra_detail_service.svc_ingest_agent_infra: create on first
sight, dedupe on hostname, update thereafter.

Three things it deliberately does NOT do:

  * It never creates a row for a node whose host could not be read. A card that
    says "Connected" because a row exists, while nothing was ever collected
    from it, is worse than no card.
  * It never overwrites a hostname, IP or SSH credential a human entered. Those
    are someone's configuration; this only fills what is blank and owns the
    fields that describe cluster membership.
  * It never deletes. A node that leaves the cluster stops being updated and
    ages out of "connected" on its own, rather than having its history removed
    by a background job.
"""

import datetime

from sqlalchemy.orm import Session

from app.models.os_server_model import OsServer

# What these rows are called on the servers page. 'Standalone' is what makes a
# host fall outside cluster grouping, so anything else groups — this name is
# the one the UI styles as a RAC node.
RAC_NODE_TYPE = "RAC Node"

def _short(h):
    return (h or "").strip().split(".")[0].lower()


def _find_existing(db, org_id, hostname, ip):
    """The row this node already has, if any.

    Hostname first — it is what the cluster calls the node and what survives an
    address change. Address second, because a host added by hand may have been
    given an address and no hostname.
    """
    short = _short(hostname)
    if short:
        for row in db.query(OsServer).filter(OsServer.org_id == org_id).all():
            if _short(row.hostname) == short or _short(row.server_name) == short:
                return row
    if ip:
        return db.query(OsServer).filter(
            OsServer.org_id == org_id, OsServer.ip_address == ip
        ).first()
    return None


def _sync_instance(db, org_id, row, n, now):
    """Mirror the node's Oracle instance state onto a DatabaseInstance row.

    OPEN is the only status that means the instance is serving. MOUNTED and
    STARTED are real states that are NOT open for business, so they read as
    Degraded rather than Running — a card saying "DB Running" over a mounted
    instance would be worse than saying nothing.
    """
    from app.models.os_server_model import DatabaseInstance

    if not row.id:
        db.flush()          # a freshly-created host has no id until flushed

    inst = (db.query(DatabaseInstance)
              .filter(DatabaseInstance.server_id == row.id,
                      DatabaseInstance.db_type == "Oracle")
              .first())
    if inst is None:
        inst = DatabaseInstance(org_id=org_id, server_id=row.id, db_type="Oracle",
                                port=1521, created_at=now)
        db.add(inst)

    status = (n.get("instance_status") or "").upper()
    inst.status = "Running" if status == "OPEN" else "Degraded" if status else "Unknown"


def sync_rac_hosts(conn_id: int, db: Session) -> dict:
    """Create or refresh one OsServer per node of this connection's RAC cluster.

    Returns a small report rather than raising: this runs inside the collector
    cycle and from a dashboard request, and neither should fail because a node
    was unreachable.
    """
    from app.models.connection_model import ConnectionMaster
    from app.services.oracle.oracle_rac_host_service import oracle_rac_node_hosts

    report = {"synced": [], "skipped": [], "errors": []}
    try:
        data = oracle_rac_node_hosts(conn_id, db)
    except Exception as exc:  # noqa: BLE001
        report["errors"].append(f"collect: {exc}")
        return report

    nodes = data.get("nodes") or []
    # One instance is not a cluster. Registering it as one would invent a
    # grouping the database does not have.
    if not data.get("is_rac") or len(nodes) < 2:
        report["skipped"].append("not a RAC cluster")
        return report

    conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not conn:
        report["errors"].append("connection not found")
        return report

    org_id = getattr(conn, "org_id", 1) or 1
    # The connection's name is what the operator already calls this database, so
    # it is what the cluster should be called on screen.
    cluster_name = (getattr(conn, "connection_name", None)
                    or getattr(conn, "name", None) or f"Oracle cluster {conn_id}")
    environment = getattr(conn, "environment", None) or "Production"
    now = datetime.datetime.utcnow()

    for n in nodes:
        host = n.get("host_name") or ""
        if not host:
            report["skipped"].append("instance with no host name")
            continue
        if not n.get("host_reachable"):
            # No metrics were collected, so there is nothing truthful to show — never CREATE a row for it. But a
            # peer row that already exists must not keep saying "Connected" from its last good read: this read
            # is the only collector that can see that host, and it just failed.
            existing = _find_existing(db, org_id, n.get("hostname") or host, n.get("ip_address"))
            if existing is not None and existing.collector == "rac-peer":
                existing.status = "Disconnected"
                existing.updated_at = now
            report["skipped"].append(f"{host}: {n.get('failure_reason') or 'unreachable'}")
            continue

        parsed_ip = n.get("ip_address")
        row = _find_existing(db, org_id, n.get("hostname") or host, parsed_ip)
        created = False

        if row is None:
            if not parsed_ip:
                report["skipped"].append(f"{host}: no usable address")
                continue
            row = OsServer(
                org_id=org_id,
                # Named by hostname, not instance name. These are HOST records
                # and the page sits them beside hosts named that way — one card
                # reading "koebomebspatdb01" next to one reading "KCDB2" is the
                # same cluster described two different ways. The instance name
                # is on the RAC tab, where instances are the subject.
                server_name=_short(host) or host,
                hostname=n.get("hostname") or host,
                ip_address=parsed_ip,
                environment=environment,
                monitoring_enabled=True,
                auto_discovery=True,
                # Reached through the agent on a sibling node, not by an agent
                # of its own and not by ActMon's own SSH poller.
                collector="agent" if n.get("is_agent_host") else "rac-peer",
                created_at=now,
            )
            db.add(row)
            created = True

        # Cluster membership is this function's to own — it is derived from
        # GV$INSTANCE every cycle and is not a user setting.
        row.node_type = RAC_NODE_TYPE
        row.cluster_name = cluster_name

        # Live metrics, in the same string form the SSH poller writes.
        if n.get("cpu_usage"):
            row.cpu_usage = n["cpu_usage"]
        if n.get("ram_usage"):
            row.ram_usage = n["ram_usage"]
        if n.get("disk_usage"):
            row.disk_usage = n["disk_usage"]
        if n.get("uptime"):
            row.uptime = n["uptime"]
        if n.get("os") and not (row.os_type or "").strip():
            row.os_type = "Linux"
        row.status = "Connected"

        # Only fill what is blank: a hostname or address someone typed is their
        # configuration, not ours to correct.
        if not (row.hostname or "").strip():
            row.hostname = n.get("hostname") or host
        if parsed_ip and not (row.ip_address or "").strip():
            row.ip_address = parsed_ip

        services = list(row.database_services or [])
        if not any(str(s).lower() == "oracle" for s in services):
            services.append("Oracle")
            row.database_services = services

        # The host's database state comes from a DatabaseInstance row; without
        # one the card can only say "Unknown" about an instance GV$INSTANCE has
        # just reported OPEN. The Oracle side is the authority here — nothing on
        # this server can TCP-probe the node to find out.
        _sync_instance(db, org_id, row, n, now)

        row.updated_at = now
        report["synced"].append({
            "host": host, "instance": n.get("instance_name"),
            "created": created, "is_agent_host": bool(n.get("is_agent_host")),
        })

    try:
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        report["errors"].append(f"commit: {exc}")
    return report
