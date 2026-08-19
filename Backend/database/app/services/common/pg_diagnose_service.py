"""
Comprehensive PostgreSQL Diagnosis Center.

Runs a full battery of read-only host checks THROUGH the agent (one composite
shell script = one round-trip), parses the sectioned output, correlates the
signals into an exact root cause with severity + confidence + recommended fix +
recovery commands, and can render a downloadable RCA report.

Everything is read-only except the explicit start-service action elsewhere.
"""
import re
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster

MARK = "===ACTMON_SECTION::"   # section delimiter emitted by the script


def _agent_token(conn_id: int, db: Session):
    from app.services.common.db_proxy_service import agent_host_for_conn
    try:
        row = agent_host_for_conn(conn_id, db)
        return row.token if row else None
    except Exception:  # noqa: BLE001
        return None


def _agent_shell(token: str, cmd: str, timeout: int = 90):
    from app.services.agent import agent_fs_service
    raw = agent_fs_service.request(token, "shell", cmd, timeout=timeout)
    if raw is None:
        return None
    txt = raw.decode("utf-8", "replace")
    if txt.startswith("EXIT:"):
        _, _, rest = txt.partition("\n")
        txt = rest
    return txt


# ── the composite diagnostic script (bash, runs on the DB host via the agent) ──
def _build_script(port: int) -> str:
    p = str(port or 5432)
    return r"""
S(){ echo ""; echo '""" + MARK + r"""'"$1"; }
# ---- discover PGDATA (works even when PG is down) ----
PGDATA=""
for u in postgresql postgresql@* postgresql-16 postgresql-15 postgresql-14 postgresql-13 postgresql-12; do
  e=$(systemctl show "$u" -p Environment 2>/dev/null | sed -n 's/.*PGDATA=\([^ ]*\).*/\1/p'); [ -n "$e" ] && PGDATA="$e" && break
done
if [ -z "$PGDATA" ]; then
  for d in /var/lib/postgresql/*/main /var/lib/pgsql/*/data /var/lib/pgsql/data /var/lib/postgresql/data /pgdata /opt/postgres/data; do
    [ -f "$d/PG_VERSION" ] && PGDATA="$d" && break
  done
fi
S OS; uname -a 2>/dev/null; (cat /etc/os-release 2>/dev/null | grep -E '^(NAME|VERSION)=' ); echo "uptime:$(uptime 2>/dev/null)"
S VERSION; (postgres --version 2>/dev/null || ls /usr/lib/postgresql/*/bin/postgres 2>/dev/null | head -1 | xargs -r -I{} {} --version 2>/dev/null); psql --version 2>/dev/null
S PGDATA_PATH; echo "$PGDATA"
S SERVICE; for u in postgresql postgresql@* postgresql-16 postgresql-15 postgresql-14 postgresql-13 postgresql-12; do st=$(systemctl is-active "$u" 2>/dev/null); [ -n "$st" ] && echo "$u=$st"; done
S SERVICE_STATUS; systemctl status postgresql --no-pager 2>&1 | head -14
S SERVICE_PROPS; systemctl show postgresql -p MainPID -p ExecMainStatus -p ExecMainCode -p NRestarts -p ActiveState -p SubState -p ActiveEnterTimestamp -p Result 2>/dev/null
S JOURNAL; journalctl -u postgresql --no-pager -n 80 --since "30 min ago" 2>/dev/null | tail -80
S PG_LOG; LOG=""; for d in /var/log/postgresql "$PGDATA/log" /var/lib/pgsql/*/data/log /var/lib/postgresql/*/main/log; do [ -d "$d" ] && LOG=$(ls -1t "$d"/*.log 2>/dev/null | head -1) && [ -n "$LOG" ] && break; done; echo "LOGFILE:$LOG"; [ -n "$LOG" ] && tail -120 "$LOG" 2>/dev/null
S PORT; ss -ltnp 2>/dev/null | grep -w ':""" + p + r"""' || echo NOTLISTENING
S DISK; df -h "$PGDATA" / 2>/dev/null; echo "--INODES--"; df -i "$PGDATA" / 2>/dev/null
S MOUNT; mount 2>/dev/null | grep -E "$(echo $PGDATA | cut -d/ -f1-3)|on / " | head -5
S MEM; free -h 2>/dev/null
S OOM; (dmesg 2>/dev/null | grep -iE 'out of memory|killed process|oom-kill' | tail -6); (journalctl -k --no-pager 2>/dev/null | grep -iE 'oom|killed process' | tail -6)
S CPU; uptime 2>/dev/null; echo "cores:$(nproc 2>/dev/null)"
S PGDATA_STAT; [ -n "$PGDATA" ] && { ls -ld "$PGDATA" 2>/dev/null; echo "--PERMS--"; stat -c '%U:%G %a' "$PGDATA" 2>/dev/null; echo "--DIRS--"; for x in base global pg_wal pg_xact pg_tblspc pg_multixact pg_commit_ts pg_stat pg_stat_tmp PG_VERSION; do [ -e "$PGDATA/$x" ] && echo "OK $x" || echo "MISSING $x"; done; }
S POSTMASTER_PID; [ -f "$PGDATA/postmaster.pid" ] && { echo "EXISTS"; head -1 "$PGDATA/postmaster.pid"; PID=$(head -1 "$PGDATA/postmaster.pid"); (kill -0 "$PID" 2>/dev/null && echo "PID_ALIVE:$PID" || echo "PID_STALE:$PID"); } || echo "NONE"
S RECOVERY; [ -f "$PGDATA/recovery.signal" ] && echo "recovery.signal" ; [ -f "$PGDATA/standby.signal" ] && echo "standby.signal" ; [ ! -f "$PGDATA/recovery.signal" ] && [ ! -f "$PGDATA/standby.signal" ] && echo "PRIMARY"
S CONFIG; CONF="$PGDATA/postgresql.conf"; [ -f "$CONF" ] && grep -vE '^\s*#|^\s*$' "$CONF" 2>/dev/null | grep -iE 'listen_addresses|^port|max_connections|shared_buffers|data_directory|hba_file|wal_level|archive_mode|archive_command|logging_collector|log_directory|ssl' | head -30 || echo "NO_CONF at $CONF"
S HBA; HBA="$PGDATA/pg_hba.conf"; [ -f "$HBA" ] && grep -vE '^\s*#|^\s*$' "$HBA" 2>/dev/null | head -20 || echo "NO_HBA"
S TABLESPACES; [ -d "$PGDATA/pg_tblspc" ] && { for l in "$PGDATA"/pg_tblspc/*; do [ -e "$l" ] && { tgt=$(readlink "$l" 2>/dev/null); [ -d "$tgt" ] && echo "OK $l -> $tgt" || echo "BROKEN $l -> $tgt"; }; done; } ; echo "done"
S WAL; [ -d "$PGDATA/pg_wal" ] && { echo "count:$(ls -1 "$PGDATA/pg_wal" 2>/dev/null | grep -cE '^[0-9A-F]{24}$')"; du -sh "$PGDATA/pg_wal" 2>/dev/null; ls -1 "$PGDATA/pg_wal/archive_status" 2>/dev/null | tail -3; } || echo "NO_PG_WAL"
S SSL; [ -n "$PGDATA" ] && for f in server.crt server.key; do [ -f "$PGDATA/$f" ] && { echo "$f perms:$(stat -c '%a %U:%G' "$PGDATA/$f" 2>/dev/null)"; [ "$f" = "server.crt" ] && (openssl x509 -in "$PGDATA/$f" -noout -enddate 2>/dev/null); } || echo "$f MISSING"; done
S PROCESSES; ps -eo pid,user,comm,args 2>/dev/null | grep -iE 'postgres|postmaster' | grep -v grep | head -20
S SELINUX; (getenforce 2>/dev/null || echo "no-selinux"); (aa-status 2>/dev/null | head -2 || echo "no-apparmor")
S FIREWALL; (ufw status 2>/dev/null | head -4 || true); (firewall-cmd --state 2>/dev/null || true)
S PACKAGES; (dpkg -l 2>/dev/null | grep -iE 'postgresql' | awk '{print $2" "$3}' | head -8) || (rpm -qa 2>/dev/null | grep -iE 'postgres' | head -8)
S NETWORK; hostname 2>/dev/null; hostname -I 2>/dev/null
S ENV; env 2>/dev/null | grep -E '^PG(DATA|HOST|PORT|USER)=' || echo "none"
S END; echo done
"""


def _split_sections(output: str) -> dict:
    sections = {}
    cur = None
    buf = []
    for line in (output or "").splitlines():
        if line.startswith(MARK):
            if cur is not None:
                sections[cur] = "\n".join(buf).strip()
            cur = line[len(MARK):].strip()
            buf = []
        elif cur is not None:
            buf.append(line)
    if cur is not None:
        sections[cur] = "\n".join(buf).strip()
    return sections


# ── Root-cause correlation ──────────────────────────────────────────────────
def _run_rca(sec: dict, agent_status: str, last_error: str, port: int) -> dict:
    ev = []          # evidence strings
    affected = []    # affected files
    failed = []      # failed components
    joined = "\n".join(sec.get(k, "") for k in
                       ("JOURNAL", "PG_LOG", "SERVICE_STATUS", "OOM")).lower()

    # signal extraction
    svc_line = sec.get("SERVICE", "")
    svc_active = "active" if "=active" in svc_line else (
        "failed" if "=failed" in svc_line else ("inactive" if "=inactive" in svc_line else "unknown"))
    listening = "NOTLISTENING" not in sec.get("PORT", "") and bool(sec.get("PORT", "").strip())
    pm = sec.get("POSTMASTER_PID", "")
    stale_pid = "PID_STALE" in pm
    missing_dirs = [ln.split()[1] for ln in sec.get("PGDATA_STAT", "").splitlines() if ln.startswith("MISSING")]
    disk = sec.get("DISK", "")
    disk_full = bool(re.search(r'\b(9[5-9]|100)%', disk))
    inode_full = "INODES" in disk and bool(re.search(r'\b(9[5-9]|100)%', disk.split("--INODES--")[-1] if "--INODES--" in disk else ""))
    readonly = "read-only" in sec.get("MOUNT", "").lower() or "read-only file system" in joined
    oom = bool(sec.get("OOM", "").strip()) or "out of memory" in joined or "killed process" in joined
    port_conflict = listening and svc_active != "active"

    def has(*words):
        return any(w in joined for w in words)

    root, sev, fix, recov, conf, downtime = None, "Medium", "", [], 60, "Unknown"

    # ordered rules (most specific / severe first)
    if svc_active == "unknown" and not sec.get("SERVICE", "").strip() and not listening:
        root = "PostgreSQL is not installed as a systemd service on this host (or a non-standard init)."
        sev, conf = "High", 60
        fix = "Confirm PostgreSQL is installed and how it's started on this host."
        recov = ["which postgres", "ls /usr/lib/postgresql/*/bin/ 2>/dev/null"]
    elif disk_full or "no space left on device" in joined:
        root = "Disk full — PostgreSQL cannot write data/WAL."
        sev, conf, downtime = "Critical", 95, "Until space is freed"
        affected += ["PGDATA filesystem"]; failed += ["storage"]
        fix = "Free disk space (old WAL/logs/backups) or extend the volume, then start PostgreSQL."
        recov = ["df -h", "du -sh $PGDATA/* | sort -h | tail", "systemctl start postgresql"]
    elif inode_full:
        root = "Inode exhaustion on the data filesystem."
        sev, conf = "Critical", 90; failed += ["storage"]
        fix = "Remove large numbers of small files (old logs/temp) to free inodes."
        recov = ["df -i", "systemctl start postgresql"]
    elif readonly:
        root = "Filesystem is read-only — PostgreSQL cannot start."
        sev, conf = "Critical", 90; failed += ["storage"]
        fix = "Remount the filesystem read-write and check the disk for errors."
        recov = ["mount | grep ' / '", "dmesg | tail", "mount -o remount,rw <mount>"]
    elif oom:
        root = "PostgreSQL was killed by the OOM killer (out of memory)."
        sev, conf = "Critical", 88; failed += ["memory", "postmaster"]
        fix = "Reduce shared_buffers/work_mem or add RAM/swap, then restart PostgreSQL."
        recov = ["free -h", "dmesg | grep -i oom", "systemctl start postgresql"]
    elif has("could not bind", "address already in use") or port_conflict:
        root = f"Port {port} is already in use by another process — PostgreSQL could not bind."
        sev, conf = "High", 85; failed += ["network/port"]
        fix = f"Find and stop the process holding port {port}, then start PostgreSQL."
        recov = [f"ss -ltnp | grep :{port}", "systemctl start postgresql"]
    elif has("permission denied"):
        root = "Permission denied on data directory / files (ownership or mode issue)."
        sev, conf = "High", 85; failed += ["filesystem permissions"]
        affected += ["PGDATA"]
        fix = "Fix ownership to postgres:postgres and mode 700 on PGDATA."
        recov = ["chown -R postgres:postgres $PGDATA", "chmod 700 $PGDATA", "systemctl start postgresql"]
    elif stale_pid:
        root = "Stale postmaster.pid left after an unclean shutdown — PostgreSQL refuses to start."
        sev, conf = "High", 88; affected += ["$PGDATA/postmaster.pid"]; failed += ["startup"]
        fix = "Remove the stale postmaster.pid (no live PID) and start PostgreSQL."
        recov = ["rm -f $PGDATA/postmaster.pid", "systemctl start postgresql"]
    elif missing_dirs:
        root = f"Data directory is incomplete/corrupt — missing: {', '.join(missing_dirs)}."
        sev, conf = "Critical", 80; failed += ["data directory"]; affected += ["PGDATA"]
        fix = "PGDATA is damaged. Restore from the latest backup (do NOT initdb over live data)."
        recov = ["ls -l $PGDATA", "# restore from backup"]
    elif has("invalid checkpoint", "wal", "invalid page", "checksum") and has("fatal", "panic"):
        root = "WAL / data corruption detected during startup."
        sev, conf, downtime = "Critical", 80, "Depends on restore"
        failed += ["WAL/heap"]
        fix = "Corruption present — recover from backup; only use pg_resetwal as a last resort."
        recov = ["# restore from base backup + WAL", "# pg_resetwal is DESTRUCTIVE — last resort"]
    elif has("configuration file", "syntax error", "unrecognized configuration parameter"):
        root = "Configuration error in postgresql.conf / pg_hba.conf prevents startup."
        sev, conf = "High", 82; affected += ["postgresql.conf", "pg_hba.conf"]; failed += ["config"]
        fix = "Fix the reported config line, then start PostgreSQL."
        recov = ["postgres -C data_directory 2>&1", "systemctl start postgresql"]
    elif svc_active in ("inactive", "failed"):
        root = "PostgreSQL service is stopped/failed and no fatal signal was found in the logs."
        sev, conf = "High", 70; failed += ["postgresql.service"]
        fix = "Start the service; if it fails immediately, inspect the journal for the cause."
        recov = ["systemctl start postgresql", "journalctl -u postgresql -n 50 --no-pager"]
    elif agent_status == "error" and not listening:
        root = "Collector cannot connect and the port is not listening — the database is down."
        sev, conf = "High", 72; failed += ["postgresql"]
        fix = "Start PostgreSQL and confirm it binds to the configured port."
        recov = ["systemctl start postgresql", f"ss -ltnp | grep :{port}"]
    elif svc_active == "active" and listening and agent_status != "online":
        root = "Service and port are up, but the collector still can't authenticate/query — likely credentials or pg_hba.conf."
        sev, conf = "Medium", 65; affected += ["pg_hba.conf"]; failed += ["authentication"]
        fix = "Verify the monitoring user's password and that pg_hba.conf permits it from localhost."
        recov = ["tail -20 $PGDATA/pg_hba.conf"]
    else:
        root = "No definitive fault found — PostgreSQL appears healthy or the issue is transient."
        sev, conf = "Low", 50
        fix = "No action required; re-run diagnosis if the problem persists."
        recov = []

    if last_error:
        ev.append(f"Collector last error: {last_error[:300]}")
    for key in ("SERVICE_STATUS", "PG_LOG", "JOURNAL"):
        v = sec.get(key, "")
        if v and any(t in v.lower() for t in ("fatal", "panic", "error", "denied", "could not", "killed")):
            ev.append(f"[{key}] " + "\n".join(
                l for l in v.splitlines()
                if any(t in l.lower() for t in ("fatal", "panic", "error", "denied", "could not", "killed"))
            )[:600])

    overall = "Healthy" if sev == "Low" else ("Down" if sev in ("Critical", "High") else "Degraded")
    return {
        "overall_health": overall,
        "root_cause": root,
        "severity": sev,
        "confidence": conf,
        "evidence": ev,
        "affected_files": sorted(set(affected)),
        "failed_components": sorted(set(failed)),
        "recommended_fix": fix,
        "recovery_commands": recov,
        "estimated_downtime": downtime,
        "preventive": [
            "Enable disk & WAL free-space alerts (avoid full-filesystem stalls).",
            "Monitor memory to prevent OOM kills; right-size shared_buffers/work_mem.",
            "Keep verified backups + PITR so corruption is always recoverable.",
            "Alert on service state so a stopped DB is caught before users notice.",
        ],
        "service_active": svc_active,
        "port_listening": listening,
    }


def pg_deep_diagnose(conn_id: int, db: Session) -> dict:
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": f"Connection {conn_id} not found"}
    port = rec.port or 5432

    ag = db.execute(text(
        "SELECT status, last_error, last_heartbeat FROM agents WHERE db_connection_id = :c LIMIT 1"),
        {"c": conn_id}).first()
    agent_status = (ag[0] if ag else None) or "unknown"
    last_error   = (ag[1] if ag else None)
    last_hb      = (ag[2].isoformat() if ag and ag[2] else None)

    token = _agent_token(conn_id, db)
    base = {
        "status": "success", "connection_id": conn_id,
        "connection_name": rec.connection_name or f"{rec.db_type}-{conn_id}",
        "db_type": rec.db_type, "host": rec.host, "port": port,
        "agent": {"linked": bool(token), "collector_status": agent_status,
                  "last_error": last_error, "last_heartbeat": last_hb},
    }
    if not token:
        base["rca"] = {"overall_health": "Unknown", "root_cause": "No agent linked — live host diagnosis unavailable.",
                       "severity": "Medium", "confidence": 40, "evidence": [], "affected_files": [],
                       "failed_components": [], "recommended_fix": "Install the agent on the DB host or add SSH creds.",
                       "recovery_commands": [], "estimated_downtime": "Unknown", "preventive": []}
        base["sections"] = {}
        return base

    # This entire diagnostic (_build_script below) is bash/systemd-specific —
    # it would run under cmd.exe on a Windows agent host and return wrong,
    # misleading "fixes" rather than failing loudly. PostgreSQL is monitored
    # on Windows too (postgres_connection_service.py has a dedicated Windows
    # log-path fallback) — say plainly this deep-diagnosis isn't ported yet,
    # rather than silently running Linux commands against Windows and
    # reporting whatever garbage comes back as a confident root cause.
    from app.services.common.diagnose_engine import os_type_for_conn, _is_windows
    if _is_windows(os_type_for_conn(conn_id, db)):
        base["rca"] = {
            "overall_health": "Unknown",
            "root_cause": "Deep diagnosis isn't available for a Windows-hosted PostgreSQL host yet "
                          "(this check is Linux/systemd-specific). Use the Diagnosis Center's basic "
                          "service/port checks instead, which do support Windows.",
            "severity": "Medium", "confidence": 0, "evidence": [], "affected_files": [],
            "failed_components": [], "recommended_fix": "Use the basic Diagnosis Center checks for this host.",
            "recovery_commands": [], "estimated_downtime": "Unknown", "preventive": [],
        }
        base["sections"] = {}
        return base

    out = _agent_shell(token, _build_script(port), timeout=120)
    if out is None:
        base["rca"] = {"overall_health": "Unknown", "root_cause": "The agent on the DB host did not respond to the diagnostic.",
                       "severity": "High", "confidence": 50, "evidence": [], "affected_files": [],
                       "failed_components": ["agent"], "recommended_fix": "Confirm the agent service is running on the host.",
                       "recovery_commands": ["systemctl status actmon-agent"], "estimated_downtime": "Unknown", "preventive": []}
        base["sections"] = {}
        return base

    sections = _split_sections(out)
    base["sections"] = sections
    base["rca"] = _run_rca(sections, agent_status, last_error, port)
    return base


# ── Downloadable RCA report (plain text / markdown) ─────────────────────────
def build_report(conn_id: int, db: Session) -> str:
    d = pg_deep_diagnose(conn_id, db)
    if d.get("status") != "success":
        return f"ActMon Diagnosis Report\nError: {d.get('error')}\n"
    rca = d.get("rca", {})
    sec = d.get("sections", {})
    L = []
    L.append("=" * 70)
    L.append("  ActMon — PostgreSQL Diagnosis & Root-Cause Report")
    L.append("=" * 70)
    L.append(f"Connection      : {d['connection_name']}  ({d['db_type']})")
    L.append(f"Host            : {d['host']}:{d['port']}")
    L.append(f"PostgreSQL      : {sec.get('VERSION','?').splitlines()[0] if sec.get('VERSION') else '?'}")
    L.append("")
    L.append("-" * 70)
    L.append("  1. OVERALL HEALTH")
    L.append("-" * 70)
    L.append(f"Status          : {rca.get('overall_health')}")
    L.append(f"Service         : {rca.get('service_active')}")
    L.append(f"Port listening  : {rca.get('port_listening')}")
    L.append(f"Collector       : {d['agent'].get('collector_status')}")
    L.append("")
    L.append("-" * 70)
    L.append("  2. ROOT CAUSE")
    L.append("-" * 70)
    L.append(rca.get("root_cause", "—"))
    L.append(f"Severity        : {rca.get('severity')}")
    L.append(f"Confidence      : {rca.get('confidence')}%")
    L.append(f"Est. downtime   : {rca.get('estimated_downtime')}")
    L.append("")
    L.append("-" * 70)
    L.append("  3. RECOMMENDED FIX")
    L.append("-" * 70)
    L.append(rca.get("recommended_fix", "—"))
    if rca.get("recovery_commands"):
        L.append("")
        L.append("Recovery commands:")
        for c in rca["recovery_commands"]:
            L.append(f"  $ {c}")
    if rca.get("affected_files"):
        L.append("")
        L.append("Affected files  : " + ", ".join(rca["affected_files"]))
    if rca.get("failed_components"):
        L.append("Failed comps    : " + ", ".join(rca["failed_components"]))
    L.append("")
    L.append("-" * 70)
    L.append("  4. EVIDENCE")
    L.append("-" * 70)
    for e in rca.get("evidence", []) or ["(no fatal log signals captured)"]:
        L.append(e)
    L.append("")
    L.append("-" * 70)
    L.append("  5. PREVENTIVE RECOMMENDATIONS")
    L.append("-" * 70)
    for p in rca.get("preventive", []):
        L.append(f"  - {p}")
    L.append("")
    L.append("=" * 70)
    L.append("  RAW DIAGNOSTIC SECTIONS")
    L.append("=" * 70)
    for name, body in sec.items():
        L.append("")
        L.append(f"### {name}")
        L.append(body or "(empty)")
    L.append("")
    L.append("Generated by ActMon Diagnosis Center")
    return "\n".join(L)
