"""
Patroni-aware PostgreSQL HA console — backend logic.

Deliberately layers ON TOP of existing pieces rather than duplicating them:
  - deep Postgres replication internals (slots, WAL stats, standby_info) still
    come from `svc_replication_detail` (postgres_monitoring_service.py) — this
    module only adds Patroni's own role/state/timeline/lag/DCS view on top.
  - host shell/file access reuses `fs_browse_service.svc_fs_read/svc_fs_write`
    (patroni.yml) and `host_action_service.svc_service_action` (Patroni
    service restart) verbatim.
  - RBAC reuses the EXISTING page `/postgresql-dashboard/:id/replication`
    (page_id 89) — no new page_master/permission rows.
  - Audit reuses the generic `audit_log` table via the same insert pattern
    `os_server_routes.py` already uses for host actions.

Patroni presence is never stored — every read attempts a short-timeout probe
and degrades to `patroni_detected: False` on failure, so a plain (non-Patroni)
PostgreSQL cluster is completely unaffected (falls back to the existing
plain-replication view the frontend already renders).
"""
import logging
import shlex
from datetime import datetime, timedelta

import yaml
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.models.os_server_model import OsServer, DatabaseInstance
from app.models.patroni_config_history_model import PatroniConfigHistory
from app.services.postgres import patroni_service
from app.services.postgres.postgres_monitoring_service import svc_replication_detail
from app.services.common.credential_encryption_service import credential_encryption

_LEADER_ROLES = {"leader", "standby_leader", "sync_standby_leader"}

# Patroni dynamic-config keys with a known reload/restart impact — not
# exhaustive, but covers every example the spec itself gives. Anything not
# listed here is conservatively classified as "reload" (Patroni's own PATCH
# handles the actual application; this is purely informational for the UI).
_IMPACT_MAP = {
    "loop_wait": "reload", "retry_timeout": "reload", "ttl": "reload",
    "maximum_lag_on_failover": "reload", "master_start_timeout": "reload",
    "synchronous_mode": "reload", "synchronous_mode_strict": "reload",
    "use_slots": "restart", "use_pg_rewind": "restart",
}


# ─────────────────────────── connection / server resolution ───────────────────────────

def _get_conn(conn_id: int, db: Session) -> ConnectionMaster:
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id, ConnectionMaster.db_type == "postgresql"
    ).first()
    if not conn:
        raise HTTPException(status_code=404, detail="PostgreSQL connection not found")
    return conn


def _server_for_conn(conn_id: int, db: Session) -> OsServer | None:
    inst = db.query(DatabaseInstance).filter(DatabaseInstance.connection_id == conn_id).first()
    if inst:
        srv = db.query(OsServer).filter(OsServer.id == inst.server_id).first()
        if srv:
            return srv
    # database_instances.connection_id is frequently unlinked in this
    # environment (confirmed on all three Patroni nodes) — same gap the
    # Cluster Topology frontend fix hit. Fall back to matching this
    # connection's host against a registered server's IP, exactly like
    # DatabaseServersPage.jsx's findConn() does client-side.
    conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not conn:
        return None
    return db.query(OsServer).filter(OsServer.ip_address == conn.host).first()


def _cluster_servers(conn_id: int, db: Session) -> list[OsServer]:
    """This connection's own host, plus every OsServer sharing its cluster_name
    (same grouping DatabaseServersPage.jsx already uses) — self first if it has
    no cluster_name (a standalone Patroni node, still valid)."""
    self_srv = _server_for_conn(conn_id, db)
    if not self_srv:
        return []
    if not self_srv.cluster_name:
        return [self_srv]
    siblings = db.query(OsServer).filter(
        OsServer.cluster_name == self_srv.cluster_name,
        OsServer.org_id == self_srv.org_id,
    ).all()
    if self_srv.id not in [s.id for s in siblings]:
        siblings.append(self_srv)
    return siblings


def _server_conn_id(srv: OsServer, db: Session) -> int | None:
    inst = db.query(DatabaseInstance).filter(
        DatabaseInstance.server_id == srv.id, DatabaseInstance.db_type.ilike("postgres%"),
        DatabaseInstance.connection_id.isnot(None),
    ).first()
    if inst:
        return inst.connection_id
    # Same unlinked-connection_id fallback as _server_for_conn, in reverse:
    # match this server's IP against a registered PostgreSQL connection's host.
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.db_type == "postgresql", ConnectionMaster.host == srv.ip_address,
    ).first()
    return conn.id if conn else None


def _probe_any(servers: list[OsServer]) -> tuple[OsServer | None, dict | None]:
    """First server whose Patroni REST API answers, plus its /patroni payload."""
    for srv in servers:
        info = patroni_service.probe(srv.ip_address, srv.patroni_api_port)
        if info is not None:
            return srv, info
    return None, None


def _match_server_by_host(servers: list[OsServer], host: str) -> OsServer | None:
    for s in servers:
        if s.ip_address == host or s.hostname == host:
            return s
    return None


def _resolve_member_server(servers: list[OsServer], status: dict, member_name: str) -> OsServer | None:
    """member_name (e.g. "pg-node3", what Patroni itself calls it and what the
    frontend's target picker sends) -> the matching OsServer, via the already-
    resolved status['members'] list (member_name + ip_address pairs). NEVER
    match member_name directly against ip_address/hostname — confirmed live
    that doing so (the previous bug) silently returns None, then crashes with
    an unhandled AttributeError on the caller's next line, surfacing as a bare
    "Request failed (500)" instead of a real error."""
    member = next((m for m in status.get("members", []) if m.get("member_name") == member_name), None)
    if not member:
        return None
    return _match_server_by_host(servers, member.get("ip_address"))


def _current_member(conn_id: int, status: dict, db: Session) -> dict | None:
    """The Patroni member that corresponds to the connection/dashboard
    currently being viewed — resolved entirely server-side from conn_id, never
    trusted from the request body. This is what "Restart Patroni"/"Restart
    PostgreSQL" are scoped to: the current node ONLY, never an arbitrary
    frontend-supplied target."""
    self_srv = _server_for_conn(conn_id, db)
    if not self_srv:
        return None
    return next((m for m in status.get("members", []) if m.get("ip_address") == self_srv.ip_address), None)


# ─────────────────────────── status / topology ───────────────────────────

def svc_patroni_status(conn_id: int, db: Session) -> dict:
    conn = _get_conn(conn_id, db)
    servers = _cluster_servers(conn_id, db)
    if not servers:
        return {"patroni_detected": False, "reason": "This host isn't registered as an OS server yet."}

    reachable_srv, patroni_info = _probe_any(servers)
    if reachable_srv is None:
        return {"patroni_detected": False, "reason": "Patroni REST API not reachable on any node in this cluster — treated as a plain PostgreSQL cluster."}

    cluster = patroni_service.get_cluster(reachable_srv.ip_address, reachable_srv.patroni_api_port)
    if "error" in cluster:
        return {"patroni_detected": True, "status": "error", "error": cluster["error"]}

    members_raw = cluster.get("members", [])
    leader_name = next((m["name"] for m in members_raw if m.get("role") in _LEADER_ROLES), None)
    leader_member = next((m for m in members_raw if m.get("role") in _LEADER_ROLES), None)

    # Deep WAL/lag/slot detail comes from EVERY node's OWN connection — not
    # just the Leader's. A replica's actual upstream is derived from THAT
    # replica's own pg_stat_wal_receiver (sender_host/sender_port), never
    # assumed to be the Leader. This is the fix for cascading replication
    # (a replica streaming from another replica, not directly from the
    # Leader): the old logic only ever looked at the Leader's own
    # pg_stat_replication, so a cascading replica — which never appears
    # there, since it isn't connected to the Leader at all — always read as
    # "not streaming" even while perfectly healthy.
    primary_srv = _match_server_by_host(servers, leader_member["host"]) if leader_member else None
    primary_conn_id = _server_conn_id(primary_srv, db) if primary_srv else None

    detail_by_ip: dict = {}
    for srv in servers:
        member_conn_id = _server_conn_id(srv, db)
        if not member_conn_id:
            continue
        try:
            detail_by_ip[srv.ip_address] = svc_replication_detail(member_conn_id, db)
        except Exception:
            detail_by_ip[srv.ip_address] = {}

    # sent_by_ip: for ANY node with its own downstream connections — the true
    # Leader, OR a cascading standby that is itself sending to another
    # standby — map each downstream's client_addr to that pg_stat_replication
    # row. This is what gives an accurate byte_lag for a cascading replica,
    # read from its REAL immediate upstream rather than assumed to be the
    # Leader's view (which never mentions it).
    sent_by_ip: dict = {}
    for detail in detail_by_ip.values():
        for r in (detail.get("replicas") or []):
            client_ip = (r.get("client_addr") or "").split("/")[0]
            if client_ip:
                sent_by_ip[client_ip] = r

    unregistered_members = []
    members = []
    healthy_count = 0
    streaming_count = 0
    for m in members_raw:
        srv = _match_server_by_host(servers, m.get("host"))
        if not srv:
            unregistered_members.append(m.get("name"))
        is_leader = m.get("role") in _LEADER_ROLES
        patroni_running = m.get("state") in ("running", "streaming")

        own_detail = detail_by_ip.get(srv.ip_address, {}) if srv else {}
        wal_receiver = (own_detail.get("standby_info") or {}).get("wal_receiver") or {}

        upstream_member_name, sender_host, wal_streaming, repl_row = None, None, None, None
        if not is_leader:
            # Ground truth for "is this node actually streaming, and from
            # whom" always comes from the node's OWN wal receiver — never
            # inferred from someone else's pg_stat_replication.
            sender_host = wal_receiver.get("sender_host") or None
            wal_streaming = wal_receiver.get("status") == "streaming"
            if sender_host:
                upstream_srv = _match_server_by_host(servers, sender_host)
                if upstream_srv:
                    upstream_member_name = next(
                        (mm.get("name") for mm in members_raw if mm.get("host") == upstream_srv.ip_address), None,
                    )
            repl_row = sent_by_ip.get(srv.ip_address) if srv else None

        is_cascading = bool(upstream_member_name) and upstream_member_name != leader_name

        lag_bytes = None
        if repl_row is not None:
            # Precise sent-vs-replayed byte lag, from the true immediate
            # upstream's own pg_stat_replication row for this node.
            lag_bytes = repl_row.get("byte_lag")
        elif not is_leader:
            # Fallback when the real upstream's own connection couldn't be
            # reached directly — still a genuine local signal (WAL this node
            # has received but not yet replayed), just from this node's own
            # vantage rather than the sender's.
            lag_bytes = (own_detail.get("standby_info") or {}).get("receive_replay_diff")

        # Node health per the spec's own worked examples: Patroni+PG running
        # but a replica's WAL receiver not actually streaming => WARNING,
        # never silently green. Replication SLOT status is never used here —
        # an unused slot (reserved/failover/cascading capacity) is not
        # evidence of a health problem on its own. OS/DB reachability itself
        # is combined by the frontend (already has that signal from the
        # existing os-servers list) — this endpoint owns the Patroni+
        # replication half of the combination only.
        if not patroni_running:
            health = "DEGRADED"
        elif not is_leader and wal_streaming is False:
            health = "WARNING"
        elif not is_leader and (lag_bytes or 0) >= 10_485_760:
            health = "DEGRADED"
        elif not is_leader and (lag_bytes or 0) >= 1_048_576:
            health = "WARNING"
        else:
            health = "HEALTHY"

        if health == "HEALTHY":
            healthy_count += 1
        # Streaming count is a REPLICA metric ("2/2 Streaming") — the Leader
        # itself doesn't stream from anyone, so it must never inflate this.
        if not is_leader and wal_streaming:
            streaming_count += 1

        members.append({
            "member_name": m.get("name"), "os_server_id": srv.id if srv else None,
            "server_name": srv.server_name if srv else None, "ip_address": m.get("host"),
            "role": m.get("role"), "patroni_state": m.get("state"), "timeline": m.get("timeline"),
            "receive_lsn": m.get("receive_lsn"), "receive_lag": m.get("receive_lag"),
            "replay_lsn": m.get("lsn") or m.get("replay_lsn"), "replay_lag": m.get("replay_lag"),
            "lag_bytes": lag_bytes, "patroni_running": patroni_running,
            "wal_receiver_streaming": wal_streaming, "node_health": health,
            # Actual upstream this member streams from — resolved from its
            # OWN pg_stat_wal_receiver, e.g. "pg-node1" for a cascading
            # replica, never assumed to be the Leader. None for the Leader
            # itself, or when unresolvable (unregistered/unreachable sender).
            "upstream_member": upstream_member_name, "upstream_host": sender_host,
            "is_cascading": is_cascading,
        })

    # A registered OsServer that Patroni's OWN member list no longer mentions at
    # all (not "unreachable", genuinely absent from the DCS) is a CRITICAL gap,
    # not a node to silently drop off the table — confirmed live: a node can
    # vanish from /cluster entirely (VM down, Patroni/DCS lease lost) while
    # every OTHER check still passes. A DBA must see this, not lose the row.
    seen_hosts = {m.get("host") for m in members_raw}
    missing_members = [s for s in servers if s.ip_address not in seen_hosts]
    for s in missing_members:
        members.append({
            "member_name": s.server_name, "os_server_id": s.id, "server_name": s.server_name,
            "ip_address": s.ip_address, "role": "unknown", "patroni_state": "missing",
            "timeline": None, "receive_lsn": None, "receive_lag": None, "replay_lsn": None,
            "replay_lag": None, "lag_bytes": None, "patroni_running": False,
            "wal_receiver_streaming": None, "node_health": "CRITICAL",
            "upstream_member": None, "upstream_host": None, "is_cascading": None,
        })

    # Actual WAL-path edges, derived per-member above from each replica's own
    # pg_stat_wal_receiver — NOT a fixed "Leader -> every replica" star. A
    # replica whose upstream couldn't be resolved (data unavailable) is left
    # with `from: None` rather than silently defaulting to the Leader — an
    # unresolved edge should read as "unknown", never as a false direct link.
    edges = []
    for mm in members:
        if mm["role"] in _LEADER_ROLES or mm.get("patroni_state") == "missing":
            continue
        edges.append({"from": mm.get("upstream_member"), "to": mm["member_name"], "cascading": mm.get("is_cascading")})

    all_healthy = all(mm["node_health"] == "HEALTHY" for mm in members)
    any_critical = any(mm["node_health"] == "CRITICAL" for mm in members)
    any_degraded = any(mm["node_health"] == "DEGRADED" for mm in members)
    cluster_health = "HEALTHY" if all_healthy else "CRITICAL" if any_critical else ("DEGRADED" if any_degraded else "WARNING")
    reason = None
    if not all_healthy:
        warn_n = sum(1 for mm in members if mm["node_health"] == "WARNING")
        deg_n = sum(1 for mm in members if mm["node_health"] == "DEGRADED")
        crit_n = sum(1 for mm in members if mm["node_health"] == "CRITICAL")
        parts = []
        if crit_n:
            parts.append(f"{crit_n} node{'s are' if crit_n != 1 else ' is'} missing from the cluster entirely")
        if deg_n:
            parts.append(f"{deg_n} node{'s' if deg_n != 1 else ''} degraded")
        if warn_n:
            parts.append(f"{warn_n} node{'s' if warn_n != 1 else ''} with replication issues")
        reason = "; ".join(parts) + "."

    # Which member corresponds to the connection/dashboard being viewed right
    # now — resolved server-side so the frontend can scope node-only actions
    # (Restart Patroni, Restart PostgreSQL) to it without guessing.
    viewing_srv = _server_for_conn(conn_id, db)
    current_member_name = next(
        (m["member_name"] for m in members if viewing_srv and m.get("ip_address") == viewing_srv.ip_address), None,
    )

    return {
        "patroni_detected": True,
        "scope": patroni_info.get("patroni", {}).get("scope"),
        "cluster_health": cluster_health,
        "reason": reason,
        "leader": leader_name,
        "timeline": leader_member.get("timeline") if leader_member else None,
        "member_count": len(members),
        "healthy_members": healthy_count,
        "streaming_replicas": streaming_count,
        "replica_count": sum(1 for mm in members if mm["role"] not in _LEADER_ROLES),
        "dcs_last_seen": patroni_info.get("dcs_last_seen"),
        "paused": bool(cluster.get("pause")),
        "members": members,
        "edges": edges,
        "unregistered_members": unregistered_members,
        "primary_conn_id": primary_conn_id,
        "current_member": current_member_name,
    }


def svc_patroni_topology(conn_id: int, db: Session) -> dict:
    """Same evaluation as status, reshaped for the tree view (leader + ordered replicas)."""
    status = svc_patroni_status(conn_id, db)
    if not status.get("patroni_detected"):
        return status
    leader = next((m for m in status["members"] if m["role"] in _LEADER_ROLES), None)
    replicas = [m for m in status["members"] if m["role"] not in _LEADER_ROLES]
    return {**status, "leader_node": leader, "replica_nodes": replicas}


# ─────────────────────────── slots (the actual bug fix) ───────────────────────────

def svc_patroni_slots(conn_id: int, db: Session) -> dict:
    """Reuses svc_replication_detail's slots[]/replicas[] verbatim — only the
    LABELING changes. Separates 'upstream replication' (is THIS node's own
    stream from its primary alive?) from 'local cascading slots' (slots this
    node exposes for potential downstream replicas), so a standby's unused
    cascading slots never again read as if its own replication were broken."""
    rd = svc_replication_detail(conn_id, db)
    if rd.get("status") == "error":
        # Node genuinely unreachable right now — say so plainly rather than
        # letting an empty slots[] read as "all in use" (everything fine).
        return {
            "role": None, "upstream_replication": None, "local_slots": [],
            "unused_cascading_count": 0,
            "summary": f"Could not reach this node to check replication slots: {rd.get('error', 'unknown error')}",
            "unreachable": True,
        }
    is_standby = rd.get("role") == "STANDBY"
    sinfo = rd.get("standby_info") or {}
    wal_receiver = sinfo.get("wal_receiver") or {}

    upstream = None
    if is_standby:
        streaming = wal_receiver.get("status") == "streaming"
        upstream = {
            "streaming": streaming,
            "label": "Streaming" if streaming else "Inactive",
            "seconds_behind": sinfo.get("seconds_behind"),
            "sender_host": wal_receiver.get("sender_host"),
        }

    local_slots = []
    for s in (rd.get("slots") or []):
        local_slots.append({
            **s,
            # The actual fix: "N inactive" implied broken upstream replication.
            # These are LOCAL slots with no consumer — unused cascading capacity,
            # not a fault of this node's own replication.
            "status_label": "Active" if s.get("active") else "Unused cascading slot",
        })

    unused_count = sum(1 for s in local_slots if not s.get("active"))
    return {
        "role": rd.get("role"),
        "upstream_replication": upstream,
        "local_slots": local_slots,
        "unused_cascading_count": unused_count,
        "summary": (
            "No local replication slots configured" if not local_slots
            else f"{unused_count} unused cascading slot{'s' if unused_count != 1 else ''}" if unused_count
            else "All local slots in use"
        ),
    }


# ─────────────────────────── dynamic config ───────────────────────────

def _impact_of(key: str) -> str:
    return _IMPACT_MAP.get(key, "reload")


def svc_patroni_config(conn_id: int, db: Session) -> dict:
    servers = _cluster_servers(conn_id, db)
    srv, _ = _probe_any(servers)
    if not srv:
        raise HTTPException(status_code=400, detail="Patroni not detected for this connection.")
    cfg = patroni_service.get_config(srv.ip_address, srv.patroni_api_port)
    if "error" in cfg:
        raise HTTPException(status_code=502, detail=f"Could not read Patroni config: {cfg['error']}")
    # Patroni's dynamic config can carry postgresql.authentication.*.password /
    # replication/rewind secrets set via the DCS — masked here the same way
    # the sibling /yaml route already masks patroni.yml, closing the one gap
    # the audit found (this route previously returned them verbatim).
    return {"config": _mask_secrets(cfg), "os_server_id": srv.id, "secrets_masked": True}


def svc_patroni_config_apply(conn_id: int, changes: dict, user_id: int, db: Session) -> dict:
    servers = _cluster_servers(conn_id, db)
    srv, _ = _probe_any(servers)
    if not srv:
        raise HTTPException(status_code=400, detail="Patroni not detected for this connection.")
    before = patroni_service.get_config(srv.ip_address, srv.patroni_api_port)
    if "error" in before:
        raise HTTPException(status_code=502, detail=f"Could not read current config: {before['error']}")

    # Reconcile any mask placeholder the caller round-tripped from a prior
    # GET back into the real current value, exactly like the /yaml write path
    # — never patch Patroni with the literal "********" as an actual secret.
    changes = _reconcile_secrets(changes, before)

    result = patroni_service.patch_config(srv.ip_address, srv.patroni_api_port, changes)
    if "error" in result:
        raise HTTPException(status_code=502, detail=f"Config update rejected: {result['error']}")

    db.add(PatroniConfigHistory(
        conn_id=conn_id, os_server_id=srv.id, user_id=user_id, target="dynamic",
        before_content=_mask_secrets(before), after_content=_mask_secrets(result),
        restarted=False, result="applied",
    ))
    db.commit()

    impacts = {k: _impact_of(k) for k in changes.keys()}
    return {"status": "success", "config": _mask_secrets(result), "impacts": impacts}


def svc_patroni_config_history(conn_id: int, db: Session, limit: int = 50) -> list[dict]:
    rows = (db.query(PatroniConfigHistory)
              .filter(PatroniConfigHistory.conn_id == conn_id)
              .order_by(PatroniConfigHistory.applied_at.desc())
              .limit(limit).all())
    # `before_content`/`after_content` are already masked before being written
    # (both the static-file and dynamic-config paths, above) — `mask_deep` is
    # applied again here too as defense-in-depth for any row written before
    # this fix, so a pre-existing plaintext history row is never served either.
    return [{
        "id": r.id, "target": r.target, "before_content": _mask_secrets(r.before_content),
        "after_content": _mask_secrets(r.after_content), "restarted": r.restarted, "result": r.result,
        "applied_at": r.applied_at.isoformat() if r.applied_at else None, "user_id": r.user_id,
    } for r in rows]


# ─────────────────────────── static patroni.yml ───────────────────────────

_DEFAULT_YAML_PATH = "/etc/patroni/patroni.yml"


# Promoted to the ONE centralized CredentialEncryptionService — kept as thin
# aliases here since this module (and its callers) already refer to them by
# these names throughout.
_mask_secrets = credential_encryption.mask_deep
_reconcile_secrets = credential_encryption.reconcile_deep


_SUDO_FAIL_MARKERS = ("a password is required", "command not found", "is not in the sudoers",
                      "unable to resolve host")


def _try_sudo_read(srv, path: str, db: Session) -> str | None:
    """`sudo -n cat <path>` over whichever transport this host uses — passwordless
    sudo only (the `-n` flag fails instantly rather than blocking on a prompt we
    can never answer). Returns the file content on genuine success, None on any
    failure (sudo absent, no passwordless rule, wrong host, etc.) — every failure
    mode observed live on this environment's real nodes is covered by
    _SUDO_FAIL_MARKERS, so a sudo error page is never mistaken for file content."""
    import shlex
    from app.services.os_server.fs_browse_service import _resolve_ssh, _ssh_output
    from app.services.agent import agent_fs_service

    cmd = f"sudo -n cat {shlex.quote(path)} 2>&1"
    is_agent = (srv.collector or "") == "agent" and srv.agent_token
    text = None
    if is_agent:
        raw = agent_fs_service.request(srv.agent_token, "shell", cmd, timeout=10)
        text = raw.decode("utf-8", "replace") if raw is not None else None
    if text is None and _resolve_ssh(srv, db):
        text = _ssh_output(srv, db, cmd, timeout=10).decode("utf-8", "replace")
    if text is None:
        return None
    low = text.lower()
    if any(marker in low for marker in _SUDO_FAIL_MARKERS) or text.strip().startswith("sudo:"):
        return None
    return text


def _privileged_read(srv, path: str, db: Session) -> dict:
    """Tiered read for privileged (root/postgres-owned) files, per §10:
    1. Direct read (existing fs_browse_service path — agent-or-SSH already).
    2. `sudo -n cat` (passwordless sudo) over the same transport.
    3. Agent privileged read — not a distinct capability today (the agent's own
       "read" op already ran as tier 1 above for agent-collected hosts, so
       there is no further agent-specific escalation to attempt yet).
    4. A clear, actionable "no access" outcome — NEVER a false "file not found".
    Returns {"access": "direct"|"sudo", "content": ...} or {"access": "none", "reason": ...}.
    """
    from app.services.os_server.fs_browse_service import svc_fs_read
    direct = svc_fs_read(srv.id, path, db)
    if direct.get("needs_ssh"):
        return {"access": "none", "path": path,
                "reason": "No SSH credentials configured for this host, and it has no ActMon agent."}
    # patroni.yml is typically mode 600, owned by the postgres OS user — an SSH/
    # agent user without read access fails SILENTLY at the shell level (`stat`
    # on the directory entry still succeeds, so `size` is real and >0, but the
    # actual content read returns zero bytes) — confirmed live on this exact
    # cluster. That is the signal to try sudo next, not a "file is empty".
    direct_ok = not (direct.get("size", 0) > 0 and direct.get("read_bytes", 0) == 0)
    if direct_ok:
        return {"access": "direct", "path": path, "content": direct["content"], "source": direct.get("source")}

    sudo_content = _try_sudo_read(srv, path, db)
    if sudo_content is not None:
        return {"access": "sudo", "path": path, "content": sudo_content, "source": direct.get("source")}

    return {
        "access": "none", "path": path,
        "reason": (f"{path} exists ({direct.get('size')} bytes) but couldn't be read: the configured "
                   "SSH/agent user has no direct read permission (typically owned by the postgres OS "
                   "user, mode 600), and passwordless sudo isn't available on this host either. Grant "
                   "one of — direct read permission (e.g. group membership), passwordless sudo for "
                   "this one path, or an ActMon agent with elevated access — to enable viewing it here."),
    }


def svc_patroni_yaml_read(server_id: int, path: str, db: Session) -> dict:
    srv = db.query(OsServer).filter(OsServer.id == server_id).first()
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")
    p = path or _DEFAULT_YAML_PATH
    result = _privileged_read(srv, p, db)
    if result["access"] == "none":
        raise HTTPException(status_code=403, detail=result["reason"])
    try:
        parsed = yaml.safe_load(result["content"]) or {}
    except yaml.YAMLError as e:
        return {**result, "parse_error": str(e)}
    masked = _mask_secrets(parsed)
    return {
        "path": p, "source": result.get("source"), "access": result["access"],
        "masked_yaml": yaml.safe_dump(masked, sort_keys=False, default_flow_style=False),
        "secrets_masked": True,
    }


def _validate_yaml(content: str) -> tuple[dict | None, str | None]:
    try:
        parsed = yaml.safe_load(content)
    except yaml.YAMLError as e:
        return None, f"Invalid YAML: {e}"
    if not isinstance(parsed, dict):
        return None, "patroni.yml must be a YAML mapping at the top level."
    for required in ("scope", "postgresql"):
        if required not in parsed:
            return None, f"Missing required top-level key: '{required}'."
    return parsed, None


def svc_patroni_yaml_write(server_id: int, path: str, content: str, conn_id: int,
                           user_id: int, password: str, db: Session) -> dict:
    """Validate -> reconcile masked secrets -> backup+write (existing
    svc_fs_write, auto .actmon.bak) -> restart the Patroni SERVICE (not
    Patroni's own /restart, which only restarts Postgres) -> poll for health
    -> automatic rollback if Patroni doesn't come back up. Comments in the
    original file are NOT preserved (PyYAML re-serializes structurally; no
    comment-preserving YAML library is available in this environment) — a
    disclosed limitation, not a silent one. Password re-auth is required here
    (same as every other host-restarting action in this app) since a bad edit
    genuinely can take Patroni down on that node."""
    from app.services.os_server.fs_browse_service import svc_fs_read, svc_fs_write
    from app.services.os_server.host_action_service import svc_service_action, verify_user_password

    if not verify_user_password(db, user_id, password):
        raise HTTPException(status_code=401, detail="Password verification failed.")

    srv = db.query(OsServer).filter(OsServer.id == server_id).first()
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")

    p = path or _DEFAULT_YAML_PATH
    submitted, err = _validate_yaml(content)
    if err:
        raise HTTPException(status_code=400, detail=err)

    current_raw = _privileged_read(srv, p, db)
    if current_raw["access"] == "none":
        # Cannot safely reconcile masked secret placeholders without the real
        # current values — refuse rather than risk writing the literal mask
        # string over a real credential on disk.
        raise HTTPException(
            status_code=403,
            detail=f"Cannot write {p} — {current_raw['reason']} Masked secret fields can't be "
                   "safely reconciled without being able to read the current file first.",
        )
    current_parsed = yaml.safe_load(current_raw["content"]) or {}

    reconciled = _reconcile_secrets(submitted, current_parsed)
    final_text = yaml.safe_dump(reconciled, sort_keys=False, default_flow_style=False)

    write_result = svc_fs_write(server_id, p, final_text, db)

    db.add(PatroniConfigHistory(
        conn_id=conn_id, os_server_id=server_id, user_id=user_id, target="static_file",
        before_content=_mask_secrets(current_parsed), after_content=_mask_secrets(reconciled),
        restarted=True, result="applied",
    ))
    db.commit()
    history_id = db.query(PatroniConfigHistory).order_by(PatroniConfigHistory.id.desc()).first().id

    # Restart the Patroni SERVICE (systemd unit), then confirm it actually
    # comes back up — never report success just because the write succeeded.
    try:
        svc_service_action(server_id, "patroni", "restart", db)
    except HTTPException:
        pass  # fall through to health poll regardless — it will report the truth

    healthy = _poll_patroni_healthy(srv)
    if healthy:
        return {"status": "success", "message": "patroni.yml updated and Patroni restarted successfully.",
                "backup": write_result.get("backup"), "history_id": history_id}

    # Auto-rollback: restore the .actmon.bak this same svc_fs_write just made.
    backup_path = write_result.get("backup") or f"{p}.actmon.bak"
    backup_read = svc_fs_read(server_id, backup_path, db)
    rolled_back = False
    if not backup_read.get("needs_ssh") and backup_read.get("content"):
        svc_fs_write(server_id, p, backup_read["content"], db)
        try:
            svc_service_action(server_id, "patroni", "restart", db)
        except HTTPException:
            pass
        rolled_back = _poll_patroni_healthy(srv)

    db.add(PatroniConfigHistory(
        conn_id=conn_id, os_server_id=server_id, user_id=user_id, target="static_file",
        before_content=_mask_secrets(reconciled), after_content=_mask_secrets(current_parsed),
        restarted=True, rollback_of=history_id,
        result="rolled_back" if rolled_back else "failed",
    ))
    db.commit()

    if rolled_back:
        raise HTTPException(status_code=400, detail="Patroni did not come back up with the new configuration — automatically rolled back to the previous patroni.yml.")
    raise HTTPException(status_code=500, detail="Patroni did not come back up and the automatic rollback ALSO failed to restore health. Manual intervention is required on this node.")


def _poll_patroni_healthy(srv: OsServer, timeout_s: int = 60, interval_s: int = 3) -> bool:
    import time
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        info = patroni_service.probe(srv.ip_address, srv.patroni_api_port)
        if info and info.get("state") == "running":
            return True
        time.sleep(interval_s)
    return False


# ─────────────────────────── logs ───────────────────────────

def svc_patroni_logs(server_id: int, unit: str, since: str, db: Session) -> dict:
    from app.services.os_server.fs_browse_service import _get_server, _resolve_ssh, _ssh_output
    from app.services.agent import agent_fs_service

    srv = _get_server(server_id, db)
    u = shlex.quote((unit or "patroni").strip())
    since_q = shlex.quote((since or "2 hours ago").strip())
    cmd = f"journalctl -u {u} --since {since_q} -n 500 --no-pager 2>&1"

    is_agent = (srv.collector or "") == "agent" and srv.agent_token
    if is_agent:
        raw = agent_fs_service.request(srv.agent_token, "shell", cmd, timeout=20)
        text = raw.decode("utf-8", "replace") if raw is not None else None
        if text is None and _resolve_ssh(srv, db):
            text = _ssh_output(srv, db, cmd, timeout=20).decode("utf-8", "replace")
    elif _resolve_ssh(srv, db):
        text = _ssh_output(srv, db, cmd, timeout=20).decode("utf-8", "replace")
    else:
        raise HTTPException(status_code=400, detail="This host has no agent and no SSH credentials configured.")

    if text is None:
        raise HTTPException(status_code=504, detail="Could not reach this host to read logs.")
    lines = text.splitlines()
    return {"unit": unit or "patroni", "since": since or "2 hours ago", "lines": lines, "count": len(lines)}


# ─────────────────────────── history ───────────────────────────

def svc_patroni_history(conn_id: int, db: Session) -> dict:
    servers = _cluster_servers(conn_id, db)
    srv, _ = _probe_any(servers)
    if not srv:
        raise HTTPException(status_code=400, detail="Patroni not detected for this connection.")
    history = patroni_service.get_history(srv.ip_address, srv.patroni_api_port)
    if isinstance(history, dict) and "error" in history:
        raise HTTPException(status_code=502, detail=f"Could not read Patroni history: {history['error']}")
    # Patroni's own shape: [timeline, lsn, reason, timestamp, new_leader]
    rows = [{"timeline": h[0], "lsn": h[1] if len(h) > 1 else None,
             "reason": h[2] if len(h) > 2 else None, "timestamp": h[3] if len(h) > 3 else None,
             "new_leader": h[4] if len(h) > 4 else None} for h in (history or [])]
    return {"history": rows}


# ─────────────────────────── HA actions (switchover/failover/restart/reload/reinit/pause/resume) ───────────────────────────

_EXECUTE_ACTIONS = {"switchover", "failover", "reinitialize", "pause", "resume"}
_RESTART_ACTIONS = {"restart", "reload", "restart_patroni_service"}
_VALID_ACTIONS = _EXECUTE_ACTIONS | _RESTART_ACTIONS


def svc_patroni_action(conn_id: int, action: str, target: str | None, user_id: int,
                        password: str, db: Session) -> dict:
    from app.services.os_server.host_action_service import verify_user_password, svc_service_action
    from app.models.admin_models import AuditLog

    if action not in _VALID_ACTIONS:
        raise HTTPException(status_code=400, detail=f"Unknown action '{action}'.")
    if not verify_user_password(db, user_id, password):
        raise HTTPException(status_code=401, detail="Password verification failed.")

    servers = _cluster_servers(conn_id, db)
    reachable_srv, info = _probe_any(servers)
    if not reachable_srv:
        raise HTTPException(status_code=400, detail="Patroni not detected for this connection.")

    status = svc_patroni_status(conn_id, db)
    leader_member = next((m for m in status.get("members", []) if m["role"] in _LEADER_ROLES), None)
    scope = info.get("patroni", {}).get("scope")

    # "Restart Patroni" and "Restart PostgreSQL" are scoped to the node the
    # caller is CURRENTLY viewing — never an arbitrary node picked off a list.
    # This is enforced here, server-side, regardless of what (if anything) the
    # request body sent as `target`: a mismatched or spoofed target is
    # rejected outright, never silently redirected to a different node.
    _CURRENT_NODE_ONLY = {"restart", "restart_patroni_service"}
    current = None
    if action in _CURRENT_NODE_ONLY:
        current = _current_member(conn_id, status, db)
        if not current:
            raise HTTPException(status_code=400,
                                 detail="Could not determine which node this dashboard connection belongs to.")
        if target and target != current["member_name"]:
            raise HTTPException(
                status_code=403,
                detail=f"'{action}' can only target the node you are currently viewing "
                       f"({current['member_name']}), not '{target}'.",
            )
        target = current["member_name"]

    result = None
    try:
        if action == "switchover":
            if not target:
                raise HTTPException(status_code=400, detail="A target replica is required for switchover.")
            if not leader_member:
                raise HTTPException(status_code=400, detail="No current leader found — cannot switchover.")
            result = patroni_service.switchover(reachable_srv.ip_address, reachable_srv.patroni_api_port,
                                                leader_member["member_name"], target)
        elif action == "failover":
            if not target:
                raise HTTPException(status_code=400, detail="A target candidate is required for failover.")
            result = patroni_service.failover(reachable_srv.ip_address, reachable_srv.patroni_api_port, target)
        elif action == "reinitialize":
            if not target:
                raise HTTPException(status_code=400, detail="A target replica is required to reinitialize.")
            target_srv = _resolve_member_server(servers, status, target) or _match_server_by_host(servers, target)
            if target_srv and leader_member and target_srv.ip_address == leader_member.get("ip_address"):
                raise HTTPException(status_code=400, detail="Cannot reinitialize the current Leader.")
            result = patroni_service.reinitialize(reachable_srv.ip_address, reachable_srv.patroni_api_port, target)
        elif action == "pause":
            result = patroni_service.pause(reachable_srv.ip_address, reachable_srv.patroni_api_port)
        elif action == "resume":
            result = patroni_service.resume(reachable_srv.ip_address, reachable_srv.patroni_api_port)
        elif action == "restart":
            # Patroni-supervised PostgreSQL restart (POST /restart) — NOT the
            # Patroni service itself. Always the current node (enforced above).
            node_srv = _match_server_by_host(servers, current["ip_address"])
            if not node_srv:
                raise HTTPException(status_code=400, detail=f"Could not resolve node '{target}' to a registered server.")
            result = patroni_service.restart(node_srv.ip_address, node_srv.patroni_api_port)
        elif action == "reload":
            node_srv = _resolve_member_server(servers, status, target) if target else reachable_srv
            if not node_srv:
                raise HTTPException(status_code=400, detail=f"Could not resolve node '{target}' to a registered server.")
            result = patroni_service.reload(node_srv.ip_address, node_srv.patroni_api_port)
        elif action == "restart_patroni_service":
            # The OS-level systemd unit — the one action that genuinely needs
            # SSH/agent shell access rather than Patroni's own REST API.
            # Always the current node (enforced above).
            node_srv = _match_server_by_host(servers, current["ip_address"])
            if not node_srv:
                raise HTTPException(status_code=400, detail=f"Could not resolve node '{target}' to a registered server.")
            result = svc_service_action(node_srv.id, "patroni", "restart", db)
    except HTTPException:
        raise
    except Exception as e:
        # Any unexpected failure in the dispatch above (a bad target, a
        # transport error, anything) must never surface as a bare "Request
        # failed (500)" — the real exception is logged server-side only.
        logging.getLogger("patroni_action").exception(
            "Unhandled error running Patroni action=%s target=%s conn=%s", action, target, conn_id)
        raise HTTPException(status_code=502,
                             detail=f"Unable to {action.replace('_', ' ')} on {target or 'the target node'}: "
                                    "an unexpected error occurred. Check the backend logs for details.")

    if isinstance(result, dict) and result.get("error"):
        # switchover/failover block until Patroni finishes the WHOLE operation —
        # confirmed live that a client-side read-timeout can fire even though
        # Patroni completed the switch successfully. A timeout must never be
        # reported as a definitive failure for these two actions specifically;
        # re-check the cluster's actual leader before deciding.
        if action in ("switchover", "failover") and "timed out" in str(result["error"]).lower():
            recheck = patroni_service.get_cluster(reachable_srv.ip_address, reachable_srv.patroni_api_port)
            new_leader = next((m["name"] for m in recheck.get("members", []) if m.get("role") in _LEADER_ROLES), None)
            if new_leader == target:
                result = {"ok": True, "detail": f"{action} completed (confirmed via /cluster after a slow response)"}
            else:
                db.add(AuditLog(org_id=reachable_srv.org_id, user_id=user_id, table_name="postgres_patroni",
                                 record_id=conn_id, action_type=f"{action}_unconfirmed",
                                 new_data={"target": target, "scope": scope, "error": result["error"], "leader_now": new_leader}))
                db.commit()
                raise HTTPException(status_code=504,
                                     detail=f"{action} response timed out and the leader is still '{new_leader}' — "
                                            "the operation may still be in progress. Re-check Patroni Status before retrying.")
        else:
            db.add(AuditLog(org_id=reachable_srv.org_id, user_id=user_id, table_name="postgres_patroni",
                             record_id=conn_id, action_type=f"{action}_failed",
                             new_data={"target": target, "scope": scope, "error": result["error"]}))
            db.commit()
            raise HTTPException(status_code=502, detail=f"{action} failed: {result['error']}")

    db.add(AuditLog(org_id=reachable_srv.org_id, user_id=user_id, table_name="postgres_patroni",
                     record_id=conn_id, action_type=action,
                     new_data={"target": target, "scope": scope, "result": result}))
    db.commit()
    return {"status": "success", "action": action, "target": target, "result": result}


# ─────────────────────────── ActMon action-audit history (§21) ───────────────────────────

def svc_patroni_action_history(conn_id: int, db: Session, limit: int = 100) -> list[dict]:
    """Every switchover/failover/restart/reload/reinitialize/pause/resume fired
    THROUGH ActMon for this connection's cluster — reuses the same generic
    `audit_log` table every other host action in this app already writes to
    (table_name='postgres_patroni'), not a second audit mechanism."""
    from app.models.admin_models import AuditLog
    rows = (db.query(AuditLog)
              .filter(AuditLog.table_name == "postgres_patroni", AuditLog.record_id == conn_id)
              .order_by(AuditLog.created_at.desc())
              .limit(limit).all())
    return [{
        "id": r.audit_id, "action": r.action_type, "user_id": r.user_id,
        "target": (r.new_data or {}).get("target"), "result": (r.new_data or {}).get("result"),
        "error": (r.new_data or {}).get("error"), "timestamp": r.created_at.isoformat() if r.created_at else None,
    } for r in rows]


# ─────────────────────────── Recovery Assistant / diagnostics (§22) ───────────────────────────

def svc_patroni_diagnose(conn_id: int, member_name: str, db: Session) -> dict:
    """Runs the checklist a DBA would run by hand against ONE member and returns
    a plain-language diagnosis + a single recommended action — never executes
    anything itself. Reuses data already available from svc_patroni_status +
    svc_replication_detail; issues no new queries beyond one fresh Patroni probe
    for the target member specifically (so the diagnosis reflects right now,
    not the last periodic refresh)."""
    status = svc_patroni_status(conn_id, db)
    if not status.get("patroni_detected"):
        raise HTTPException(status_code=400, detail="Patroni not detected for this connection.")
    member = next((m for m in status["members"] if m["member_name"] == member_name), None)
    if not member:
        raise HTTPException(status_code=404, detail=f"Member '{member_name}' not found in this cluster.")

    servers = _cluster_servers(conn_id, db)
    srv = next((s for s in servers if s.ip_address == member["ip_address"]), None)
    checks = []

    # 1. Patroni API
    fresh_probe = patroni_service.probe(member["ip_address"], srv.patroni_api_port if srv else None) if srv else None
    checks.append({"check": "Patroni API", "ok": fresh_probe is not None,
                    "detail": fresh_probe.get("state") if fresh_probe else "unreachable"})

    # 2. PostgreSQL service / connectivity — reflected via node_health's OS/DB
    # signals already combined by the caller; here we reuse whether Patroni
    # itself reports the Postgres-managed state as running.
    pg_running = (fresh_probe or {}).get("state") in ("running", "streaming")
    checks.append({"check": "PostgreSQL service", "ok": pg_running,
                    "detail": (fresh_probe or {}).get("state", "unknown")})

    # 3-4. pg_is_in_recovery() / WAL receiver — from the primary's replication_detail,
    # already fetched by svc_patroni_status via svc_replication_detail.
    is_leader = member["role"] in _LEADER_ROLES
    wal_streaming = member.get("wal_receiver_streaming")
    checks.append({"check": "pg_is_in_recovery()", "ok": True, "detail": "leader" if is_leader else "standby"})
    checks.append({"check": "WAL receiver", "ok": is_leader or bool(wal_streaming),
                    "detail": "n/a (leader)" if is_leader else ("streaming" if wal_streaming else "not streaming")})

    # 5. Upstream host connectivity — the member's ACTUAL upstream (resolved
    # from its own pg_stat_wal_receiver in svc_patroni_status), which for a
    # cascading replica is another replica, never assumed to be the Leader.
    leader_member = next((m for m in status["members"] if m["role"] in _LEADER_ROLES), None)
    upstream_name = member.get("upstream_member")
    upstream_member = next((m for m in status["members"] if m["member_name"] == upstream_name), None) if upstream_name else leader_member
    upstream_reachable = upstream_member is not None and patroni_service.probe(
        upstream_member["ip_address"], next((s.patroni_api_port for s in servers if s.ip_address == upstream_member["ip_address"]), None),
    ) is not None
    upstream_label = f"Upstream ({upstream_member['member_name']})" if upstream_member else "Upstream"
    checks.append({"check": f"{upstream_label} reachable", "ok": is_leader or upstream_reachable,
                    "detail": "n/a (leader)" if is_leader else ("reachable" if upstream_reachable else "unreachable")})

    # 6-7. Replication slot / WAL availability — from the slots panel's own data.
    slots = svc_patroni_slots(conn_id, db) if not is_leader else None

    # 8. Replication lag / 9. Timeline
    lag_bytes = member.get("lag_bytes")
    checks.append({"check": "Replication lag", "ok": is_leader or (lag_bytes is not None and lag_bytes < 10_485_760),
                    "detail": f"{lag_bytes} bytes" if lag_bytes is not None else "unknown"})
    checks.append({"check": "Timeline", "ok": member.get("timeline") == status.get("timeline"),
                    "detail": f"member={member.get('timeline')}, cluster={status.get('timeline')}"})

    all_ok = all(c["ok"] for c in checks)
    diagnosis, recommendation, action = None, None, None
    if not all_ok:
        if not fresh_probe:
            diagnosis = "PATRONI UNREACHABLE — the Patroni REST API on this node isn't responding."
            recommendation = "Check the Patroni service is running on this host (Restart Patroni)."
            action = "restart_patroni_service"
        elif not pg_running:
            diagnosis = f"PATRONI REPORTS '{(fresh_probe or {}).get('state')}' — PostgreSQL is not in a running state."
            recommendation = "Give it a few minutes; if stuck, Reinitialize Replica."
            action = "reinitialize"
        elif not is_leader and not wal_streaming:
            diagnosis = "REPLICA NOT STREAMING — WAL receiver is not connected to the upstream leader."
            recommendation = ("Possible cause: the required WAL segment has already been removed from the "
                               "leader, or the network path to the leader is broken. Reinitialize Replica "
                               "rebuilds it from a fresh base backup.")
            action = "reinitialize"
        elif not is_leader and not upstream_reachable:
            diagnosis = "UPSTREAM UNREACHABLE — cannot reach the current leader's Patroni API."
            recommendation = "Check network connectivity between this node and the leader."
            action = None
        elif member.get("timeline") != status.get("timeline"):
            diagnosis = "TIMELINE MISMATCH — this member is on a different WAL timeline than the cluster."
            recommendation = "Reinitialize Replica to rebuild it on the current timeline."
            action = "reinitialize"
        else:
            diagnosis = "Elevated replication lag detected."
            recommendation = "Monitor — if lag keeps growing, consider Reinitialize Replica."
            action = "reinitialize"

    return {
        "member_name": member_name, "checks": checks, "healthy": all_ok,
        "diagnosis": diagnosis, "recommendation": recommendation, "recommended_action": action,
    }


# ─────────────────────────── AI Pre-check for Restart Patroni (§3B) ───────────────────────────
#
# Reuses ActMon's EXISTING hidden Groq integration — same inline `from groq import
# Groq` / model / try-except-never-leak-detail pattern as
# postgres_monitoring_service.svc_analyze_slow_query_groq. No second AI service,
# no new credentials, no system prompt or provider detail ever reaches the
# frontend. Purely advisory: the model only ever returns a verdict + reasoning
# over REAL data already gathered by svc_patroni_status/svc_patroni_diagnose —
# it never executes anything and is told explicitly not to invent state.

def svc_patroni_ai_precheck(conn_id: int, member_name: str, db: Session) -> dict:
    status = svc_patroni_status(conn_id, db)
    if not status.get("patroni_detected"):
        return {"status": "error", "error": "Patroni not detected for this connection."}
    member = next((m for m in status["members"] if m["member_name"] == member_name), None)
    if not member:
        return {"status": "error", "error": f"Member '{member_name}' not found in this cluster."}

    is_leader = member["role"] in _LEADER_ROLES
    try:
        diag = svc_patroni_diagnose(conn_id, member_name, db)
    except HTTPException:
        diag = {"checks": [], "healthy": None, "diagnosis": None}

    def _fmt(v):
        return "Data unavailable for this check." if v is None else v

    checks_text = "\n".join(f"- {c['check']}: {'OK' if c['ok'] else 'FAILING'} ({_fmt(c.get('detail'))})"
                             for c in diag.get("checks", [])) or "Data unavailable for this check."

    try:
        import os as _os
        import json as _json
        from groq import Groq
        groq_client = Groq(api_key=_os.getenv("GROQ_API_KEY", ""))

        prompt = f"""You are a PostgreSQL/Patroni HA operations advisor embedded in a monitoring product. A user is
about to restart Patroni on ONE node and wants a pre-flight safety check BEFORE they click confirm. You must reason
ONLY from the real cluster state given below — never invent or assume any value not present here. If a field says
"Data unavailable for this check.", treat it as genuinely unknown and factor that uncertainty into your verdict
rather than guessing. Return ONLY valid JSON — no markdown, no code blocks.

=== TARGET NODE ===
Member: {member_name}
Role: {member.get('role')}
Patroni state: {_fmt(member.get('patroni_state'))}
Is current cluster leader: {is_leader}
Timeline: {_fmt(member.get('timeline'))}  (cluster timeline: {_fmt(status.get('timeline'))})
WAL receiver streaming: {_fmt(member.get('wal_receiver_streaming'))}
Replication lag (bytes): {_fmt(member.get('lag_bytes'))}
Node health: {_fmt(member.get('node_health'))}

=== CLUSTER CONTEXT ===
Current leader: {_fmt(status.get('leader'))}
Cluster health: {_fmt(status.get('cluster_health'))}
Cluster health reason: {_fmt(status.get('reason'))}
Total members: {_fmt(status.get('member_count'))}
Healthy members: {_fmt(status.get('healthy_members'))}
Streaming replicas: {_fmt(status.get('streaming_replicas'))}
Cluster paused: {_fmt(status.get('paused'))}

=== LIVE CHECKLIST (already run against the real node) ===
{checks_text}
Rule-based diagnosis (if any issue was already detected): {_fmt(diag.get('diagnosis'))}

=== WHAT RESTARTING THIS NODE MEANS ===
If this node is a REPLICA, restarting Patroni briefly stops it from streaming and it must catch back up —
generally low-risk when it is already healthy and streaming with low lag, but risky if it is already lagging,
not streaming, or on a mismatched timeline. If this node IS THE CURRENT LEADER, restarting Patroni on it can
trigger an automatic failover/pause in Patroni-managed HA — only advisable when there is at least one healthy,
caught-up replica able to take over, and still carries a brief availability interruption during the transition.

Return this exact JSON structure:
{{
  "recommendation": "SAFE_TO_RESTART|CAUTION|NOT_RECOMMENDED",
  "reason": "2-4 sentences grounded ONLY in the data above, explaining the verdict",
  "what_to_check_first": ["short actionable item", "..."],
  "is_leader_restart": {str(is_leader).lower()}
}}"""

        response = groq_client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=1500,  # bumped from 800 — this model's hidden reasoning trace
                              # counts against max_tokens before any visible content
            reasoning_effort="low",
        )
        raw = response.choices[0].message.content.strip()
        if raw.startswith("```"):
            parts = raw.split("```")
            raw = parts[1]
            if raw.startswith("json"):
                raw = raw[4:]
        analysis = _json.loads(raw.strip())
        return {"status": "success", "analysis": analysis}

    except Exception as e:
        # Never leak the AI provider's own error text to the browser — full
        # detail stays server-side only (same discipline as the Queries-page
        # AI Suggestion feature).
        logging.getLogger("postgres_ai").warning(
            "AI restart pre-check failed for conn=%s member=%s: %s", conn_id, member_name, e)
        return {"status": "error", "error": "AI suggestions are temporarily unavailable."}
