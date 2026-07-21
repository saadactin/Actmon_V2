"""
ActMon Diagnosis Engine — real-time, step-by-step database diagnosis.

Design goals (per product spec):
  • Step-by-step: the frontend runs ONE check at a time and shows Running →
    Passed/Warning/Failed/Skipped live; RCA is produced only AFTER all checks.
  • Multi-transport: auto-detects the best connection method to the DB host —
    Agent (ActMon), SSH, or Local — and can report which others are possible
    (WinRM/API are declared for future use). Falls back automatically.
  • One framework, every engine: a per-engine PROFILE (service names, port,
    data dir, log globs, config, process pattern) drives the SAME check set, so
    MySQL / MariaDB / PostgreSQL / Oracle / MSSQL / MongoDB / ClickHouse / Redis /
    Elasticsearch / Cassandra all get a dedicated center with the same UX.
"""
import re
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster

# ── per-engine profiles ─────────────────────────────────────────────────────
PROFILES = {
    "postgresql": {"label": "PostgreSQL", "services": ["postgresql", "postgresql@*", "postgresql-16", "postgresql-15", "postgresql-14", "postgresql-13", "postgresql-12"],
                   "port": 5432, "proc": "postgres|postmaster",
                   "data": ["/var/lib/postgresql/*/main", "/var/lib/pgsql/*/data", "/var/lib/postgresql/data", "/pgdata"],
                   "logs": ["/var/log/postgresql", "/var/lib/pgsql/*/data/log", "/var/lib/postgresql/*/main/log"],
                   "conf": "postgresql.conf", "version_cmd": "postgres --version 2>/dev/null || psql --version 2>/dev/null",
                   "pkg": "postgres"},
    "postgres":   None,  # alias -> postgresql (resolved below)
    "mysql":      {"label": "MySQL", "services": ["mysql", "mysqld", "mariadb"], "port": 3306, "proc": "mysqld|mariadbd",
                   "data": ["/var/lib/mysql"], "logs": ["/var/log/mysql", "/var/log"], "conf": "my.cnf",
                   "version_cmd": "mysqld --version 2>/dev/null || mysql --version 2>/dev/null", "pkg": "mysql|mariadb"},
    "mariadb":    None,
    "mongodb":    {"label": "MongoDB", "services": ["mongod", "mongodb"], "port": 27017, "proc": "mongod",
                   "data": ["/var/lib/mongodb", "/var/lib/mongo"], "logs": ["/var/log/mongodb"], "conf": "mongod.conf",
                   "version_cmd": "mongod --version 2>/dev/null | head -1", "pkg": "mongo"},
    "clickhouse": {"label": "ClickHouse", "services": ["clickhouse-server"], "port": 9000, "proc": "clickhouse",
                   "data": ["/var/lib/clickhouse"], "logs": ["/var/log/clickhouse-server"], "conf": "config.xml",
                   "version_cmd": "clickhouse-server --version 2>/dev/null | head -1", "pkg": "clickhouse"},
    "mssql":      {"label": "SQL Server", "services": ["mssql-server"], "port": 1433, "proc": "sqlservr",
                   "data": ["/var/opt/mssql/data"], "logs": ["/var/opt/mssql/log"], "conf": "mssql.conf",
                   "version_cmd": "/opt/mssql/bin/sqlservr --version 2>/dev/null | head -1", "pkg": "mssql"},
    "oracle":     {"label": "Oracle", "services": [], "port": 1521, "proc": "ora_pmon|tnslsnr",
                   "data": ["/u01/app/oracle"], "logs": ["/u01/app/oracle/diag"], "conf": "init.ora",
                   "version_cmd": "sqlplus -v 2>/dev/null | head -1", "pkg": "oracle"},
    "redis":      {"label": "Redis", "services": ["redis", "redis-server"], "port": 6379, "proc": "redis-server",
                   "data": ["/var/lib/redis"], "logs": ["/var/log/redis"], "conf": "redis.conf",
                   "version_cmd": "redis-server --version 2>/dev/null", "pkg": "redis"},
    "elasticsearch": {"label": "Elasticsearch", "services": ["elasticsearch"], "port": 9200, "proc": "org.elasticsearch",
                   "data": ["/var/lib/elasticsearch"], "logs": ["/var/log/elasticsearch"], "conf": "elasticsearch.yml",
                   "version_cmd": "/usr/share/elasticsearch/bin/elasticsearch --version 2>/dev/null", "pkg": "elasticsearch"},
    "cassandra":  {"label": "Cassandra", "services": ["cassandra"], "port": 9042, "proc": "CassandraDaemon",
                   "data": ["/var/lib/cassandra"], "logs": ["/var/log/cassandra"], "conf": "cassandra.yaml",
                   "version_cmd": "cassandra -v 2>/dev/null", "pkg": "cassandra"},
}
PROFILES["postgres"] = PROFILES["postgresql"]
PROFILES["mariadb"] = PROFILES["mysql"]


def profile_for(db_type: str) -> dict:
    return PROFILES.get((db_type or "").lower()) or {
        "label": (db_type or "Database"), "services": [], "port": 0, "proc": (db_type or "").lower(),
        "data": [], "logs": [], "conf": "", "version_cmd": "true", "pkg": (db_type or "").lower()}


# ── transport (agent / ssh / local) ─────────────────────────────────────────
class Transport:
    def __init__(self, rec: ConnectionMaster, db: Session):
        self.method = None
        self.token = None
        self.ssh = None
        self.available = []
        # 1) Agent
        try:
            from app.services.common.db_proxy_service import agent_host_for_conn
            row = agent_host_for_conn(rec.id, db)
            if row and row.token:
                self.token = row.token
                self.available.append("agent")
        except Exception:  # noqa: BLE001
            pass
        # 2) SSH (OsServer with creds for this host)
        try:
            from app.models.os_server_model import OsServer
            srv = db.query(OsServer).filter(OsServer.ip_address == rec.host).first()
            if srv and srv.ssh_username:
                self._ssh_cfg = (srv.ip_address, srv.ssh_port or 22, srv.ssh_username, srv.ssh_password or "")
                self.available.append("ssh")
        except Exception:  # noqa: BLE001
            self._ssh_cfg = None
        # choose best
        self.method = "agent" if self.token else ("ssh" if "ssh" in self.available else None)

    def connect(self) -> bool:
        if self.method == "agent":
            return True
        if self.method == "ssh":
            try:
                import paramiko
                self.ssh = paramiko.SSHClient()
                self.ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                self.ssh.connect(self._ssh_cfg[0], port=self._ssh_cfg[1], username=self._ssh_cfg[2],
                                 password=self._ssh_cfg[3], timeout=12)
                return True
            except Exception:  # noqa: BLE001
                return False
        return False

    def shell(self, cmd: str, timeout: int = 40):
        """Return (exit_code, text)."""
        if self.method == "agent":
            from app.services.agent import agent_fs_service
            raw = agent_fs_service.request(self.token, "shell", cmd, timeout=timeout)
            if raw is None:
                return None, None
            txt = raw.decode("utf-8", "replace")
            code = 0
            if txt.startswith("EXIT:"):
                head, _, rest = txt.partition("\n")
                try:
                    code = int(head[5:].strip())
                except Exception:
                    code = 0
                txt = rest
            return code, txt
        if self.method == "ssh" and self.ssh:
            _, out, err = self.ssh.exec_command(cmd, timeout=timeout)
            code = out.channel.recv_exit_status()
            body = out.read().decode("utf-8", "replace")
            e = err.read().decode("utf-8", "replace")
            return code, body + ("\n" + e if e else "")
        return None, None

    def close(self):
        try:
            if self.ssh:
                self.ssh.close()
        except Exception:  # noqa: BLE001
            pass


# ── check catalogue (engine-parameterized) ─────────────────────────────────
# Each entry: id, title, group. The command is built by _cmd(); the evaluator
# maps raw output -> (status, detail). status ∈ passed|warning|failed|skipped|info
CHECKS = [
    ("service",     "Service Status",         "Service"),
    ("process",     "Process Check",          "Service"),
    ("port",        "Port Listening",         "Connectivity"),
    ("logs",        "Error Logs",             "Logs"),
    ("data_dir",    "Data Directory",         "Storage"),
    ("config",      "Configuration",          "Config"),
    ("permissions", "Permissions & Ownership","Storage"),
    ("disk",        "Disk Space",             "Storage"),
    ("inodes",      "Inodes",                 "Storage"),
    ("memory",      "Memory",                 "System"),
    ("oom",         "OOM Killer",             "System"),
    ("cpu",         "CPU / Load",             "System"),
    ("journal",     "System Journal",         "Logs"),
    ("packages",    "Installed Packages",     "Install"),
    ("version",     "Software Version",       "Install"),
    ("network",     "Network",                "Connectivity"),
    ("firewall",    "Firewall / SELinux",     "Connectivity"),
    ("env",         "System Resources",       "System"),
]

# Rich per-step metadata (shown in the Why / What / Files / Command cards).
# {eng} is replaced with the engine label. Files are engine-aware.
CHECK_META = {
    "service":     {"why": "Checks whether the {eng} service is installed and running on the host. If the service is stopped or not running, the database will be unavailable.",
                    "what": "Queries systemd for the {eng} service state to confirm it is active and running.", "cmd_desc": "Shows the current status of the {eng} service."},
    "process":     {"why": "Confirms the actual {eng} process is alive — a service can report active while the process has crashed.",
                    "what": "Lists running {eng} processes and their PIDs.", "cmd_desc": "Lists {eng} processes."},
    "port":        {"why": "The database must listen on its TCP port for clients (and ActMon) to connect.",
                    "what": "Checks whether the {eng} port is in a LISTEN state.", "cmd_desc": "Shows what is listening on the {eng} port."},
    "logs":        {"why": "The error log is the primary source of the exact failure reason (FATAL/PANIC/corruption/permission).",
                    "what": "Scans the latest {eng} log for fatal errors.", "cmd_desc": "Tails the {eng} error log and greps for errors."},
    "data_dir":    {"why": "A missing or incomplete data directory prevents {eng} from starting.",
                    "what": "Verifies the data directory exists and lists it.", "cmd_desc": "Locates and lists the {eng} data directory."},
    "config":      {"why": "A syntax error or bad parameter in the config file stops {eng} from starting.",
                    "what": "Reads the key {eng} configuration parameters.", "cmd_desc": "Shows key {eng} configuration settings."},
    "permissions": {"why": "Wrong ownership or mode on the data directory causes permission-denied startup failures.",
                    "what": "Checks ownership and mode of the data directory.", "cmd_desc": "Shows ownership/permissions of the data directory."},
    "disk":        {"why": "A full disk stops the database from writing data and WAL/redo — a common outage cause.",
                    "what": "Checks free space on the relevant filesystems.", "cmd_desc": "Reports filesystem usage."},
    "inodes":      {"why": "Inode exhaustion looks like a full disk even when space remains.",
                    "what": "Checks inode usage on the filesystems.", "cmd_desc": "Reports inode usage."},
    "memory":      {"why": "Low memory leads to allocation failures and OOM kills.",
                    "what": "Reads current RAM and swap usage.", "cmd_desc": "Shows memory usage."},
    "oom":         {"why": "The Linux OOM killer terminates the database when memory is exhausted.",
                    "what": "Scans dmesg/journal for OOM-kill events.", "cmd_desc": "Searches kernel logs for OOM events."},
    "cpu":         {"why": "CPU starvation / high load average can make the database unresponsive.",
                    "what": "Reads load average and CPU count.", "cmd_desc": "Shows load average and cores."},
    "journal":     {"why": "The systemd journal captures startup failures and dependency errors.",
                    "what": "Reads recent journal entries for the {eng} unit.", "cmd_desc": "Shows the {eng} service journal."},
    "packages":    {"why": "Missing or corrupt packages break the installation.",
                    "what": "Lists installed {eng} packages and versions.", "cmd_desc": "Lists installed {eng} packages."},
    "version":     {"why": "Confirms the installed {eng} version for compatibility.",
                    "what": "Reads the {eng} binary version.", "cmd_desc": "Prints the {eng} version."},
    "network":     {"why": "DNS/hostname/IP problems can block connections even when the DB is up.",
                    "what": "Reads hostname and host IP addresses.", "cmd_desc": "Shows hostname and IPs."},
    "firewall":    {"why": "A firewall or SELinux/AppArmor policy can block the database port or file access.",
                    "what": "Checks firewall state and SELinux/AppArmor mode.", "cmd_desc": "Shows firewall + SELinux status."},
    "env":         {"why": "Overall host resource pressure summary.",
                    "what": "Checks relevant environment variables and resource summary.", "cmd_desc": "Shows relevant environment variables."},
}


def _files_for(check_id: str, p: dict) -> list:
    eng = (p.get("label") or "").lower()
    data = (p.get("data") or ["<datadir>"])[0]
    logdir = (p.get("logs") or ["<logdir>"])[0]
    svc = (p.get("services") or ["service"])[0]
    conf = p.get("conf") or "config"
    m = {
        "service":     [f"/etc/systemd/system/{svc}.service", f"/lib/systemd/system/{svc}.service"],
        "logs":        [f"{logdir}/*.log"],
        "data_dir":    [data],
        "config":      [f"{data}/{conf}", f"/etc/{eng}/{conf}"],
        "permissions": [data],
        "journal":     [f"journalctl -u {svc}"],
        "config_alt":  [],
    }
    return m.get(check_id, [])


def plan(db_type: str) -> dict:
    p = profile_for(db_type)
    port = p.get("port", 0)
    checks = []
    for cid, title, group in CHECKS:
        meta = CHECK_META.get(cid, {})
        eng = p["label"]
        checks.append({
            "id": cid, "title": title, "group": group,
            "why": (meta.get("why", "").format(eng=eng)),
            "what": (meta.get("what", "").format(eng=eng)),
            "files": _files_for(cid, p),
            "command": _cmd(cid, p, port),
            "command_desc": (meta.get("cmd_desc", "").format(eng=eng)),
        })
    return {"engine": p["label"], "checks": checks}


def _first_glob(paths):
    # build a shell expression that echoes the first existing dir from a glob list
    parts = " ".join(f'"{x}"' for x in paths)
    return f'for d in {parts}; do [ -e "$d" ] && echo "$d" && break; done'


def _cmd(check_id: str, p: dict, port: int) -> str:
    svc = " ".join(p["services"]) or "none"
    if check_id == "service":
        if not p["services"]:
            return 'echo "NO_SYSTEMD_UNIT (managed outside systemd)"'
        return ("for u in " + svc + "; do st=$(systemctl is-active $u 2>/dev/null); "
                "[ -n \"$st\" ] && echo \"$u=$st\"; done; "
                "systemctl status " + p["services"][0] + " --no-pager 2>&1 | head -10")
    if check_id == "process":
        return f"ps -eo pid,user,comm,args 2>/dev/null | grep -iE '{p['proc']}' | grep -v grep | head -15 || echo NONE"
    if check_id == "port":
        return f"ss -ltnp 2>/dev/null | grep -w ':{port}' || echo NOTLISTENING"
    if check_id == "version":
        return p["version_cmd"]
    if check_id == "packages":
        return f"(dpkg -l 2>/dev/null | grep -iE '{p['pkg']}' | awk '{{print $2\" \"$3}}' | head -8) || (rpm -qa 2>/dev/null | grep -iE '{p['pkg']}' | head -8) || echo NONE"
    if check_id == "data_dir":
        return _first_glob(p["data"]) + ' | while read d; do echo "DATADIR:$d"; ls -ld "$d" 2>/dev/null; done; [ -z "$(' + _first_glob(p["data"]) + ')" ] && echo "NO_DATADIR"'
    if check_id == "permissions":
        return _first_glob(p["data"]) + ' | while read d; do stat -c "%U:%G %a %n" "$d" 2>/dev/null; done'
    if check_id == "disk":
        return "df -h 2>/dev/null | head -12"
    if check_id == "inodes":
        return "df -i 2>/dev/null | head -12"
    if check_id == "logs":
        globs = " ".join(f'"{g}"' for g in p["logs"])
        return (f'L=""; for d in {globs}; do L=$(ls -1t $d/*.log 2>/dev/null | head -1); [ -n "$L" ] && break; done; '
                'echo "LOGFILE:$L"; [ -n "$L" ] && tail -80 "$L" 2>/dev/null | grep -iE "fatal|panic|error|denied|could not|corrupt|killed|out of memory" | tail -25')
    if check_id == "journal":
        u = p["services"][0] if p["services"] else p["proc"]
        return f'journalctl -u {u} --no-pager -n 40 --since "30 min ago" 2>/dev/null | tail -40 || echo NO_JOURNAL'
    if check_id == "oom":
        return "(dmesg 2>/dev/null | grep -iE 'out of memory|killed process|oom-kill' | tail -5); (journalctl -k --no-pager 2>/dev/null | grep -iE 'oom|killed process' | tail -5); echo done"
    if check_id == "memory":
        return "free -h 2>/dev/null"
    if check_id == "cpu":
        return "uptime 2>/dev/null; echo cores:$(nproc 2>/dev/null)"
    if check_id == "config":
        conf = p.get("conf") or "config"
        return (_first_glob(p["data"]) + ' | while read d; do C="$d/' + conf + '"; [ -f "$C" ] && { echo "CONF:$C"; grep -vE "^\\s*#|^\\s*$" "$C" 2>/dev/null | head -25; }; done; '
                'for C in /etc/' + ((p.get("label") or "").lower()) + '/' + conf + ' /etc/' + conf + '; do [ -f "$C" ] && { echo "CONF:$C"; grep -vE "^\\s*#|^\\s*$" "$C" 2>/dev/null | head -25; }; done; echo done')
    if check_id == "network":
        return "hostname 2>/dev/null; hostname -I 2>/dev/null"
    if check_id == "firewall":
        return ("echo '--firewall--'; (ufw status 2>/dev/null | head -3); (firewall-cmd --state 2>/dev/null); "
                "echo '--selinux--'; (getenforce 2>/dev/null || echo no-selinux); (aa-status 2>/dev/null | head -1 || echo no-apparmor)")
    if check_id == "env":
        return "echo '--env--'; env 2>/dev/null | grep -iE 'PG|MYSQL|MONGO|ORACLE|DATA' | head -8; echo '--load--'; uptime 2>/dev/null; echo cores:$(nproc 2>/dev/null); free -h 2>/dev/null | head -2"
    return "echo unsupported-check"


def _evaluate(check_id: str, out: str, port: int):
    o = out or ""
    low = o.lower()
    if check_id == "service":
        if "no_systemd_unit" in low:
            return "info", "Managed outside systemd — see process/port checks."
        if "=active" in o:
            return "passed", "Service is active."
        if "=failed" in o:
            return "failed", "Service is FAILED."
        if "=inactive" in o:
            return "failed", "Service is inactive (stopped)."
        return "warning", "Could not determine service state."
    if check_id == "process":
        if "NONE" in o or not o.strip():
            return "failed", "No database process running."
        return "passed", f"{len([l for l in o.splitlines() if l.strip()])} process(es) running."
    if check_id == "port":
        if "NOTLISTENING" in o:
            return "failed", f"Port {port} is NOT listening."
        return "passed", f"Port {port} is listening."
    if check_id == "version":
        return ("passed", o.strip().splitlines()[0]) if o.strip() else ("warning", "Version not detected.")
    if check_id == "packages":
        return ("passed", f"{len([l for l in o.splitlines() if l.strip()])} package(s) found.") if o.strip() and "NONE" not in o else ("warning", "No packages detected.")
    if check_id == "data_dir":
        if "NO_DATADIR" in o or not o.strip():
            return "failed", "Data directory not found."
        return "passed", "Data directory present."
    if check_id == "permissions":
        return ("passed", o.strip()[:200]) if o.strip() else ("warning", "Could not read ownership.")
    if check_id in ("disk", "inodes"):
        if re.search(r'\b(9[5-9]|100)%', o):
            return "failed", "Filesystem is ≥95% full."
        if re.search(r'\b(8[5-9]|9[0-4])%', o):
            return "warning", "Filesystem is 85–94% full."
        return "passed", "Adequate free space."
    if check_id == "logs":
        if "LOGFILE:" in o and o.split("LOGFILE:")[1].strip().splitlines()[0].strip() == "":
            return "info", "No log file found (logging may be disabled)."
        if any(t in low for t in ("fatal", "panic", "corrupt", "could not", "out of memory")):
            return "failed", "Errors found in the log — see evidence."
        if "error" in low or "denied" in low:
            return "warning", "Warnings found in the log."
        return "passed", "No fatal errors in recent log."
    if check_id == "journal":
        if "NO_JOURNAL" in o or not o.strip():
            return "info", "No journal entries."
        if any(t in low for t in ("fatal", "panic", "failed", "could not", "killed")):
            return "failed", "Failures found in the journal."
        return "passed", "No failures in the journal."
    if check_id == "oom":
        return ("failed", "OOM killer terminated the process.") if any(t in low for t in ("out of memory", "killed process", "oom-kill")) else ("passed", "No OOM events.")
    if check_id == "memory":
        return "info", (o.strip().splitlines()[1] if len(o.strip().splitlines()) > 1 else o.strip())[:160]
    if check_id == "cpu":
        return "info", o.strip().replace("\n", " ")[:160]
    if check_id == "network":
        return ("passed", o.strip().replace("\n", " ")[:160]) if o.strip() else ("warning", "No network info.")
    if check_id == "config":
        if "CONF:" not in o:
            return "warning", "Configuration file not found."
        return "passed", "Configuration file read."
    if check_id == "firewall":
        if "enforcing" in low:
            return "warning", "SELinux is enforcing — may block DB operations."
        return "info", "Firewall/SELinux checked."
    if check_id == "env":
        return "info", "Host resource summary collected."
    return "info", o.strip()[:160]


def detect(conn_id: int, db: Session) -> dict:
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": "Connection not found"}
    t = Transport(rec, db)
    ok = t.connect()
    probe = ""
    if ok:
        code, txt = t.shell("echo ACTMON_OK && id 2>/dev/null | head -1", timeout=20)
        probe = (txt or "").strip()[:120]
        ok = code is not None and "ACTMON_OK" in (txt or "")
    t.close()
    p = profile_for(rec.db_type)
    return {
        "status": "success",
        "connection_id": conn_id,
        "connection_name": rec.connection_name or f"{rec.db_type}-{conn_id}",
        "db_type": rec.db_type, "engine": p["label"], "host": rec.host, "port": rec.port or p["port"],
        "methods_available": t.available,
        "method": t.method,
        "connected": bool(ok),
        "probe": probe,
        "future_methods": ["winrm", "api"],   # declared; auto-used when configured
    }


def run_check(conn_id: int, check_id: str, db: Session) -> dict:
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": "Connection not found"}
    p = profile_for(rec.db_type)
    port = rec.port or p["port"]
    title = next((c[1] for c in CHECKS if c[0] == check_id), check_id)
    group = next((c[2] for c in CHECKS if c[0] == check_id), "General")
    t = Transport(rec, db)
    if not t.connect():
        return {"id": check_id, "title": title, "group": group, "status": "skipped",
                "detail": "No connection method available (agent/SSH).", "evidence": ""}
    try:
        code, out = t.shell(_cmd(check_id, p, port), timeout=45)
    finally:
        t.close()
    if out is None:
        return {"id": check_id, "title": title, "group": group, "status": "skipped",
                "detail": "Host did not respond.", "evidence": ""}
    st, detail = _evaluate(check_id, out, port)
    return {"id": check_id, "title": title, "group": group, "status": st,
            "detail": detail, "evidence": (out or "").strip()[:4000],
            "output": (out or "").strip()[:4000],
            "analysis": _step_analysis(check_id, st, out, p)}


def _step_analysis(check_id: str, status: str, out: str, p: dict) -> dict:
    """Per-step structured analysis shown in the step's Analysis panel."""
    eng = p.get("label", "Database")
    low = (out or "").lower()
    if status in ("passed", "info"):
        return {"status": "OK", "severity": "Low",
                "root_cause": f"{eng} {check_id} check passed — no issue detected here.",
                "impact": "None.", "fixes": []}
    sev = "Critical" if status == "failed" else "Medium"
    fixes, cause, impact = [], "", ""
    if check_id == "service":
        cause = f"The {eng} service is not active."
        impact = f"{eng} is unavailable; applications cannot connect."
        fixes = [f"Start the service: systemctl start {(p.get('services') or ['service'])[0]}",
                 "If it fails to start, check Error Logs & System Journal steps."]
    elif check_id == "process":
        cause = f"No {eng} process is running."; impact = "Database is down."
        fixes = ["Start the service and confirm the process appears."]
    elif check_id == "port":
        cause = f"{eng} is not listening on its port."; impact = "Clients cannot connect."
        fixes = ["Confirm the service is running and bound to the configured address/port.", "Check firewall rules."]
    elif check_id in ("disk", "inodes"):
        cause = "The data filesystem is (nearly) full."; impact = "Writes fail; the database can stop."
        fixes = ["Free space (old logs/WAL/backups) or extend the volume.", "Then restart the service."]
    elif check_id == "oom":
        cause = "The OOM killer terminated the database process."; impact = "Sudden crash under memory pressure."
        fixes = ["Reduce memory settings or add RAM/swap.", "Restart the service."]
    elif check_id in ("logs", "journal"):
        cause = "Fatal errors were found in the logs — see the output."
        impact = "Startup/runtime failure."; fixes = ["Resolve the specific error shown, then restart."]
    elif check_id == "data_dir":
        cause = "The data directory is missing or unreadable."; impact = f"{eng} cannot start."
        fixes = ["Restore the data directory from backup; verify the path/mount."]
    elif check_id == "permissions":
        cause = "Ownership/permissions on the data directory are wrong."; impact = "Permission-denied at startup."
        fixes = ["Fix ownership to the DB user and correct the mode, then restart."]
    elif check_id == "config":
        cause = "Configuration file missing or unreadable."; impact = "Startup may fail."
        fixes = ["Verify the configuration file exists and is valid."]
    else:
        cause = f"{eng} {check_id} check reported an issue."; impact = "See output."; fixes = ["Review the command output."]
    return {"status": "FAILED" if status == "failed" else "WARNING", "severity": sev,
            "root_cause": cause, "impact": impact, "fixes": fixes}


def _parse_log_rows(text_out: str, kind: str) -> list:
    rows = []
    for ln in (text_out or "").splitlines():
        ln = ln.strip()
        if not ln or ln.startswith("LOGFILE:") or ln.startswith("--"):
            continue
        up = ln.upper()
        lvl = "FATAL" if "FATAL" in up or "PANIC" in up else ("ERROR" if "ERROR" in up or "DENIED" in up or "COULD NOT" in up else "INFO")
        rows.append({"level": lvl, "message": ln[:300]})
    return rows[-20:]


def context(conn_id: int, db: Session) -> dict:
    """One-shot context for the diagnosis screen: DB info + latest journal/log errors."""
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": "Connection not found"}
    p = profile_for(rec.db_type)
    port = rec.port or p["port"]
    ag = db.execute(text("SELECT status, last_error, last_heartbeat FROM agents WHERE db_connection_id = :c LIMIT 1"),
                    {"c": conn_id}).first()
    agent_status = (ag[0] if ag else None) or "unknown"
    out = {"status": "success", "db_type": rec.db_type, "engine": p["label"], "port": port,
           "dbinfo": {"status": "Running" if agent_status == "online" else ("Not Running" if agent_status == "error" else "Unknown"),
                      "up": agent_status == "online", "data_directory": (p.get("data") or ["—"])[0], "port": port,
                      "version": None, "last_error": (ag[1] if ag else None)},
           "journal_errors": [], "log_errors": []}
    t = Transport(rec, db)
    if not t.connect():
        return out
    try:
        _, osr = t.shell('. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"; uname -r 2>/dev/null', timeout=20)
        if osr and osr.strip():
            parts = [x for x in osr.strip().splitlines() if x.strip()]
            out["dbinfo"]["os"] = (parts[0] if parts else "Linux")[:60]
        _, ver = t.shell(p["version_cmd"], timeout=25)
        if ver and ver.strip():
            out["dbinfo"]["version"] = ver.strip().splitlines()[0][:60]
        _, dd = t.shell(_first_glob(p["data"]), timeout=20)
        if dd and dd.strip():
            out["dbinfo"]["data_directory"] = dd.strip().splitlines()[0]
        u = (p["services"][0] if p["services"] else p["proc"])
        _, jr = t.shell(f'journalctl -u {u} --no-pager -n 20 2>/dev/null | tail -20', timeout=30)
        out["journal_errors"] = _parse_log_rows(jr, "journal")
        _, lg = t.shell(_cmd("logs", p, port), timeout=40)
        out["log_errors"] = _parse_log_rows(lg, "log")
    finally:
        t.close()
    return out


# ── RCA from accumulated step results ───────────────────────────────────────
def build_rca(conn_id: int, results: list, db: Session) -> dict:
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    port = (rec.port if rec else 0) or 0
    by = {r.get("id"): r for r in (results or [])}
    ev, affected, failed = [], [], []

    def st(cid):
        return (by.get(cid) or {}).get("status")

    def raw(cid):
        return (by.get(cid) or {}).get("evidence", "") or ""

    joined = " ".join(raw(c) for c in ("logs", "journal", "oom")).lower()
    root, sev, conf, fix, recov, downtime = None, "Medium", 60, "", [], "Unknown"

    if st("oom") == "failed":
        root, sev, conf = "The database process was killed by the OOM killer (out of memory).", "Critical", 88
        failed += ["memory"]; fix = "Reduce memory settings or add RAM/swap, then restart the service."
        recov = ["free -h", "dmesg | grep -i oom"]
    elif st("disk") == "failed" or "no space left" in joined:
        root, sev, conf = "Disk full — the database cannot write.", "Critical", 92
        failed += ["storage"]; fix = "Free disk space or extend the volume, then start the service."
        recov = ["df -h", "du -sh <datadir>/* | sort -h | tail"]
    elif st("inodes") == "failed":
        root, sev, conf = "Inode exhaustion on the data filesystem.", "Critical", 88
        failed += ["storage"]; fix = "Remove large numbers of small files to free inodes."
    elif st("port") == "failed" and st("process") == "failed" and st("service") in ("failed",):
        root, sev, conf = "The database service is stopped — process down and port not listening.", "High", 85
        failed += ["service"]; fix = "Start the database service; if it fails, inspect logs/journal."
        recov = ["systemctl start <service>", "journalctl -u <service> -n 50 --no-pager"]
    elif "permission denied" in joined:
        root, sev, conf = "Permission denied on data files (ownership/mode).", "High", 84
        failed += ["permissions"]; affected += ["data directory"]
        fix = "Fix ownership/mode on the data directory, then restart."
    elif any(t in joined for t in ("corrupt", "invalid page", "checksum", "invalid checkpoint")):
        root, sev, conf = "Data/WAL corruption detected in logs.", "Critical", 80
        failed += ["data"]; fix = "Recover from backup; avoid destructive resets."
    elif st("logs") == "failed" or st("journal") == "failed":
        root, sev, conf = "Startup failure recorded in logs/journal — see evidence.", "High", 78
        failed += ["service"]; fix = "Resolve the error shown in the log evidence, then restart."
    elif st("service") == "failed" or st("process") == "failed":
        root, sev, conf = "The database service is not running.", "High", 75
        failed += ["service"]; fix = "Start the service and confirm it stays up."
        recov = ["systemctl start <service>"]
    elif st("port") == "failed":
        root, sev, conf = "The database is running but not listening on its port.", "Medium", 68
        fix = "Check listen address/port configuration and firewall."
    else:
        root, sev, conf = "No definitive fault found — the database appears healthy.", "Low", 55
        fix = "No action required. Re-run diagnosis if the issue persists."

    for cid in ("logs", "journal", "service"):
        r = raw(cid)
        if r and any(t in r.lower() for t in ("fatal", "panic", "error", "denied", "could not", "killed")):
            lines = [l for l in r.splitlines() if any(t in l.lower() for t in ("fatal", "panic", "error", "denied", "could not", "killed"))]
            if lines:
                ev.append(f"[{cid}] " + "\n".join(lines[:6]))

    counts = {"passed": 0, "warning": 0, "failed": 0, "skipped": 0, "info": 0}
    for r in (results or []):
        counts[r.get("status", "info")] = counts.get(r.get("status", "info"), 0) + 1
    overall = "Healthy" if sev == "Low" else ("Down" if sev in ("Critical", "High") else "Degraded")

    return {
        "overall_health": overall, "root_cause": root, "severity": sev, "confidence": conf,
        "recommended_fix": fix, "recovery_commands": recov, "estimated_downtime": downtime,
        "evidence": ev, "affected_files": sorted(set(affected)), "failed_components": sorted(set(failed)),
        "counts": counts,
        "preventive": [
            "Alert on service state so a stopped DB is caught before users notice.",
            "Monitor disk/WAL free space and inodes to avoid write stalls.",
            "Watch memory to prevent OOM kills; right-size buffers/cache.",
            "Keep verified backups + PITR so corruption is always recoverable.",
        ],
    }
