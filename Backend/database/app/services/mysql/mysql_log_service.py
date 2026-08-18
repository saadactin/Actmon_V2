import asyncio
import json
import os
import re
import socket
import threading
import time
from datetime import datetime
from typing import List, Optional
from urllib.parse import quote_plus

import paramiko
from dotenv import load_dotenv
from fastapi import HTTPException
from groq import Groq
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.services.mysql.mysql_ai_analysis import analyze_mysql_error
from app.services.mysql.mysql_self_heal_service import run_mysql_self_heal

load_dotenv()
_groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))

SELF_HEAL_HISTORY_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    "data", "mysql_self_heal_history",
)

# ── Log classification patterns ───────────────────────────────────────────────

MYSQL_LOG_LEVEL_PATTERN = re.compile(
    r"\[(ERROR|WARNING|NOTE|INFO|INFORMATION|SYSTEM)\]", re.IGNORECASE
)

CRITICAL_PATTERNS = [
    r"\bcrash\b(?!\s+recovery\s+finished)",
    r"\bfatal\b",
    r"\bcorrupt(?:ed|ion)?\b",
    r"\bassertion\b",
    r"\bout of memory\b",
    r"\bdisk full\b",
    r"\bcan't start server\b",
    r"\bcannot start server\b",
    r"\baborting\b",
    r"\bshutdown complete\b.*\bafter error\b",
    r"\bport\b.*\b(in use|failed|address already in use)\b",
    r"\bbind on tcp/ip port failed\b",
]

ERROR_PATTERNS = [
    r"\berror\b", r"\bfailed\b", r"\bfailure\b", r"\bdenied\b",
    r"\bnot found\b", r"\bunknown variable\b", r"\bunable to\b",
    r"\bcannot\b", r"\bcan't\b",
]

WARNING_PATTERNS = [r"\bwarning\b", r"\bdeprecated\b", r"\bunsafe\b", r"\bretry\b", r"\btimeout\b"]

RESOLVED_PATTERNS = [
    r"\binitialization has ended\b", r"\bready for connections\b",
    r"\bcrash recovery finished\b", r"\bxa crash recovery finished\b",
    r"\bshutdown complete\b", r"\bcompleted\b", r"\bsuccessfully\b",
]

HEALTHY_MYSQL_STATE_PATTERNS = [
    r"\binitialization has ended\b", r"\bready for connections\b", r"\bserver is operational\b",
]

NORMAL_SYSTEM_PATTERNS = [
    r"\binitialization has started\b", r"\binitialization has ended\b",
    r"\bcrash recovery finished\b", r"\bxa crash recovery finished\b",
    r"\bready for connections\b",
]

PENDING_PATTERNS = [r"\binitialization has started\b", r"\bstarting\b", r"\bretry\b", r"\bwaiting\b", r"\brecovering\b"]

INFO_HINTS = [
    r"\binitialization has started\b", r"\binitialization has ended\b",
    r"\bready for connections\b", r"\bstarting\b", r"\bstarted\b",
    r"\bended\b", r"\bcompleted\b", r"\bplugin\b",
]

_SSH_CONNECT_TIMEOUT = 3


# ── SSH helpers ───────────────────────────────────────────────────────────────

def _read_file_via_ssh(host: str, port: int, username: str, password: str, filepath: str):
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(hostname=host, port=int(port or 22), username=username,
                    password=password, timeout=_SSH_CONNECT_TIMEOUT,
                    look_for_keys=False, allow_agent=False)
        _, stdout, stderr = ssh.exec_command(f"cat '{filepath}'", timeout=20)
        content = stdout.read().decode("utf-8", errors="ignore")
        err = stderr.read().decode("utf-8", errors="ignore").strip()
        if not content and err:
            return None, err
        return content, None
    except Exception as e:
        return None, str(e)
    finally:
        try: ssh.close()
        except: pass


def _ssh_read_errorlog(host: str, port: int, username: str, password: str, extra_paths: list = None):
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(hostname=host, port=int(port or 22), username=username,
                    password=password, timeout=_SSH_CONNECT_TIMEOUT,
                    look_for_keys=False, allow_agent=False)
    except Exception:
        return None, None, None

    def run(cmd):
        try:
            _, out, _ = ssh.exec_command(cmd, timeout=20)
            return out.read().decode("utf-8", errors="ignore")
        except Exception:
            return ""

    try:
        discovered = run(
            "find /var/lib/mysql /var/log/mysql /var/log/mariadb "
            "-maxdepth 2 \\( -name '*.err' -o -name 'error.log' \\) "
            "2>/dev/null | head -5"
        ).splitlines()

        file_paths = [p.strip() for p in discovered if p.strip()]
        if extra_paths:
            file_paths += [p for p in extra_paths if p]
        file_paths += [
            "/var/log/mysql/error.log",
            "/var/log/mariadb/mariadb.log",
            "/var/lib/mysql/mysql.err",
        ]
        file_paths = list(dict.fromkeys(file_paths))

        for fp in file_paths:
            content = run(f"cat '{fp}' 2>/dev/null")
            if content and len(content.strip()) > 10:
                return content, "ssh_file", fp

        for label, cmd in [
            ("ssh_journald",
             "journalctl -u mariadb --no-pager -n 500 --output=short-iso 2>/dev/null "
             "|| journalctl -u mariadb.service --no-pager -n 500 --output=short-iso 2>/dev/null "
             "|| journalctl -u mysql --no-pager -n 500 --output=short-iso 2>/dev/null"),
            ("ssh_syslog",
             "grep -iE 'mariadb|mysqld|InnoDB' /var/log/syslog 2>/dev/null | tail -300 "
             "|| grep -iE 'mariadb|mysqld' /var/log/daemon.log 2>/dev/null | tail -300"),
        ]:
            content = run(cmd)
            lines = [l for l in content.splitlines()
                     if l.strip() and not l.startswith("Hint:") and not l.startswith("--")]
            if len(lines) > 2:
                return "\n".join(lines), label, label

        return None, None, None
    finally:
        try: ssh.close()
        except: pass


# ── Log parsing helpers ───────────────────────────────────────────────────────

def _matches_any(value, patterns):
    return any(re.search(pattern, value, re.IGNORECASE) for pattern in patterns)


def classify_mysql_log_line(line: str) -> dict:
    normalized  = line.strip()
    lower_line  = normalized.lower()
    mysql_level = None

    level_match = MYSQL_LOG_LEVEL_PATTERN.search(normalized)
    if level_match:
        mysql_level = level_match.group(1).upper()

    if mysql_level in ("SYSTEM", "NOTE", "INFO", "INFORMATION") and _matches_any(lower_line, NORMAL_SYSTEM_PATTERNS):
        severity = "INFO"
    elif _matches_any(lower_line, CRITICAL_PATTERNS):
        severity = "CRITICAL"
    elif mysql_level == "ERROR":
        severity = "ERROR"
    elif mysql_level == "WARNING":
        severity = "WARNING"
    elif mysql_level in ("SYSTEM", "NOTE", "INFO", "INFORMATION"):
        severity = "INFO"
    elif _matches_any(lower_line, ERROR_PATTERNS) and not _matches_any(lower_line, INFO_HINTS):
        severity = "ERROR"
    elif _matches_any(lower_line, WARNING_PATTERNS):
        severity = "WARNING"
    else:
        severity = "INFO"

    if severity in ("CRITICAL", "ERROR"):
        status = "OPEN"
    elif _matches_any(lower_line, RESOLVED_PATTERNS):
        status = "RESOLVED"
    elif severity == "WARNING" or _matches_any(lower_line, PENDING_PATTERNS):
        status = "PENDING"
    else:
        status = "RESOLVED"

    if severity in ("CRITICAL", "ERROR"):
        category = "ERROR"
    elif severity == "WARNING":
        category = "WARNING"
    else:
        category = "MESSAGE"

    return {"severity": severity, "status": status, "category": category,
            "mysql_level": mysql_level or "INFO"}


def resolve_mysql_log_timeline(logs: list, mysql_is_down: bool = False) -> list:
    latest_healthy_index = None
    for index, log in enumerate(logs):
        msg = log.get("message", "").lower()
        if log.get("severity") == "INFO" and _matches_any(msg, HEALTHY_MYSQL_STATE_PATTERNS):
            latest_healthy_index = index

    for index, log in enumerate(logs):
        msg = log.get("message", "").lower()
        if _matches_any(msg, RESOLVED_PATTERNS):
            log["status"] = "RESOLVED"
        if (latest_healthy_index is not None and index < latest_healthy_index
                and log.get("severity") in ("CRITICAL", "ERROR", "WARNING")):
            log["status"] = "RESOLVED"
            log["resolution_hint"] = "A later MySQL healthy/startup message was found."
        if (mysql_is_down
                and index > (latest_healthy_index if latest_healthy_index is not None else -1)
                and log.get("severity") in ("CRITICAL", "ERROR")):
            log["status"] = "OPEN"
    return logs


def build_mysql_log_summary(logs: list) -> dict:
    severities = {"CRITICAL": 0, "ERROR": 0, "WARNING": 0, "INFO": 0}
    statuses   = {"OPEN": 0, "PENDING": 0, "RESOLVED": 0}
    categories = {"ERROR": 0, "WARNING": 0, "MESSAGE": 0}
    for log in logs:
        severities[log["severity"]]  = severities.get(log["severity"],  0) + 1
        statuses[log["status"]]      = statuses.get(log["status"],      0) + 1
        categories[log["category"]]  = categories.get(log["category"],  0) + 1
    return {"severities": severities, "statuses": statuses, "categories": categories}


def _parse_ssh_log_lines(lines: list, mysql_is_down: bool) -> list:
    logs = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        cls = classify_mysql_log_line(line)
        ts  = re.search(r'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}', line)
        logs.append({
            "logged":      ts.group(0).replace("T", " ")[:19] if ts else None,
            "severity":    cls["severity"],
            "status":      cls["status"],
            "category":    cls["category"],
            "mysql_level": cls["mysql_level"],
            "message":     line,
            "subsystem":   "MySQL",
        })
    logs = resolve_mysql_log_timeline(logs, mysql_is_down)
    logs.reverse()
    return logs


def tail_file(filepath: str, n: int = 300) -> list:
    try:
        with open(filepath, "rb") as f:
            try:
                f.seek(0, os.SEEK_END)
            except ValueError:
                return []
            position   = f.tell()
            lines      = []
            buffer     = bytearray()
            chunk_size = 4096
            while position > 0 and len(lines) <= n:
                read_size  = min(chunk_size, position)
                position  -= read_size
                f.seek(position)
                chunk  = f.read(read_size)
                buffer = chunk + buffer
                lines  = buffer.split(b"\n")
            return [line.decode("utf-8", errors="ignore") for line in lines[-n:]]
    except Exception as e:
        print(f"Error tailing file {filepath}: {e}")
        return []


def _safe_fetch_all(conn, sql: str):
    try:
        result = conn.execute(text(sql))
        return [dict(row._mapping) for row in result.fetchall()]
    except Exception as e:
        return {"error": str(e)}


def collect_mysql_diagnostic_context(connection: ConnectionMaster) -> dict:
    encoded_password = quote_plus(connection.password)
    mysql_url = (
        f"mysql+pymysql://{connection.username}:{encoded_password}"
        f"@{connection.host}:{connection.port}/{connection.database_name}"
    )
    context = {
        "connection_host": connection.host,
        "database":        connection.database_name,
        "note":            "Live point-in-time diagnostics.",
    }
    try:
        engine = create_engine(mysql_url, connect_args={"connect_timeout": 2, "read_timeout": 2, "write_timeout": 2})
        with engine.connect() as conn:
            context["processlist"] = _safe_fetch_all(conn, """
                SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, LEFT(INFO, 500) AS INFO
                FROM information_schema.PROCESSLIST
                WHERE COMMAND <> 'Sleep' ORDER BY TIME DESC LIMIT 10
            """)
            context["largest_tables_mb"] = _safe_fetch_all(conn, """
                SELECT TABLE_SCHEMA, TABLE_NAME,
                    ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) AS SIZE_MB, TABLE_ROWS
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA NOT IN ('mysql','sys','performance_schema','information_schema')
                ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC LIMIT 10
            """)
            context["status_counters"] = _safe_fetch_all(conn, """
                SHOW GLOBAL STATUS WHERE Variable_name IN (
                    'Threads_running','Threads_connected','Questions','Slow_queries',
                    'Created_tmp_disk_tables','Innodb_row_lock_waits','Innodb_buffer_pool_reads')
            """)
            context["top_statement_digests"] = _safe_fetch_all(conn, """
                SELECT SCHEMA_NAME, DIGEST_TEXT, COUNT_STAR,
                    ROUND(SUM_TIMER_WAIT / 1000000000000, 2) AS TOTAL_SECONDS,
                    ROUND(AVG_TIMER_WAIT / 1000000000000, 4) AS AVG_SECONDS,
                    SUM_ROWS_EXAMINED, SUM_ROWS_SENT
                FROM performance_schema.events_statements_summary_by_digest
                WHERE DIGEST_TEXT IS NOT NULL ORDER BY SUM_TIMER_WAIT DESC LIMIT 10
            """)
    except Exception as e:
        context["collection_error"] = str(e)
    return context


# ═════════════════════════════════════════════════════════════════════════════
#  Service functions
# ═════════════════════════════════════════════════════════════════════════════

def get_error_logs(conn_id: int, db: Session) -> dict:
    connection = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not connection:
        raise HTTPException(404, "Connection not found")

    encoded_password = quote_plus(connection.password)
    mysql_url = (
        f"mysql+pymysql://{connection.username}:{encoded_password}"
        f"@{connection.host}:{connection.port}/{connection.database_name}"
    )
    mysql_error_path = None
    mysql_is_down    = False
    _is_local_host   = connection.host in ("localhost", "127.0.0.1", "::1", socket.gethostname())

    # 1. Try performance_schema.error_log (MySQL 8.0.22+)
    try:
        ps_engine = create_engine(mysql_url, connect_args={"connect_timeout": 2, "read_timeout": 5, "write_timeout": 5})
        with ps_engine.connect() as ps_conn:
            ps_rows = ps_conn.execute(text("""
                SELECT DATE_FORMAT(LOGGED, '%Y-%m-%d %H:%i:%s') AS logged,
                    THREAD_ID, PRIO,
                    IFNULL(ERROR_CODE,'')    AS error_code,
                    IFNULL(SUBSYSTEM,'MySQL') AS subsystem,
                    DATA
                FROM performance_schema.error_log
                ORDER BY LOGGED DESC LIMIT 500
            """)).fetchall()

        logs = []
        for row in ps_rows:
            d    = dict(row._mapping)
            prio = (d.get("PRIO") or "Note").strip()
            data = d.get("DATA") or ""
            if prio == "Error":
                sev = "CRITICAL" if any(p in data.lower() for p in ["crash","fatal","abort","corrupt","assertion"]) else "ERROR"
            elif prio == "Warning":
                sev = "WARNING"
            elif prio == "System":
                sev = "CRITICAL" if any(p in data.lower() for p in ["aborting","crash","fatal"]) else "INFO"
            else:
                sev = "INFO"
            logs.append({
                "logged":      d.get("logged"),
                "severity":    sev,
                "subsystem":   d.get("subsystem", "MySQL"),
                "error_code":  d.get("error_code", ""),
                "message":     data,
                "status":      "OPEN" if sev in ("CRITICAL","ERROR") else "RESOLVED",
                "category":    "ERROR" if sev in ("CRITICAL","ERROR") else ("WARNING" if sev == "WARNING" else "MESSAGE"),
                "mysql_level": prio,
            })
        return {"status": "success", "source": "performance_schema", "log_path": None,
                "mysql_down": False, "total": len(logs), "summary": build_mysql_log_summary(logs), "logs": logs}
    except Exception:
        pass

    # 2. Get log path from MySQL
    try:
        engine = create_engine(mysql_url, connect_args={"connect_timeout": 2, "read_timeout": 2, "write_timeout": 2})
        with engine.connect() as conn:
            result = conn.execute(text("SHOW VARIABLES LIKE 'log_error'")).fetchone()
        mysql_error_path = result[1]
        if mysql_error_path.startswith(".\\"):
            mysql_error_path = os.path.join(
                r"C:\ProgramData\MySQL\MySQL Server 8.0\Data",
                mysql_error_path.replace(".\\", ""),
            )
    except Exception:
        mysql_is_down = True
        if _is_local_host:
            hostname       = socket.gethostname()
            fallback_paths = [
                rf"C:\ProgramData\MySQL\MySQL Server 8.0\Data\{hostname}.err",
                r"C:\ProgramData\MySQL\MySQL Server 8.0\Data\mysql_error.log",
                r"C:\ProgramData\MySQL\MySQL Server 8.0\Data\error.log",
            ]
            for path in fallback_paths:
                if os.path.exists(path):
                    mysql_error_path = path
                    break
            if not mysql_error_path:
                data_dir = r"C:\ProgramData\MySQL\MySQL Server 8.0\Data"
                if os.path.exists(data_dir):
                    for f in os.listdir(data_dir):
                        if f.endswith(".err") or f.endswith(".log"):
                            mysql_error_path = os.path.join(data_dir, f)
                            break

    # 3. SSH fallback when file not accessible
    if not mysql_error_path or not os.path.exists(mysql_error_path):
        _ssh_logs        = None
        _ssh_source      = "ssh_file"
        _ssh_path_used   = None

        if connection.ssh_user and connection.ssh_password:
            _ssh_host = connection.ssh_host or connection.host
            _ssh_port = connection.ssh_port or 22
            _extra    = []
            if mysql_error_path:
                _extra.append(mysql_error_path)
                if not mysql_error_path.startswith('/'):
                    _extra.append('/var/lib/mysql/' + mysql_error_path.lstrip('./\\'))
            _content, _ssh_source, _ssh_path_used = _ssh_read_errorlog(
                _ssh_host, _ssh_port, connection.ssh_user, connection.ssh_password, extra_paths=_extra
            )
            if _content:
                raw_lines = [l for l in _content.splitlines()[-500:] if l.strip()]
                _ssh_logs = _parse_ssh_log_lines(raw_lines, mysql_is_down)

        if _ssh_logs is not None:
            note = "SSH log retrieved but contained no parseable entries." if not _ssh_logs else None
            return {
                "status": "success", "source": _ssh_source, "log_path": _ssh_path_used,
                "mysql_down": mysql_is_down, "total": len(_ssh_logs),
                "summary": build_mysql_log_summary(_ssh_logs), "logs": _ssh_logs,
                "note": note, "ssh_host": connection.ssh_host or connection.host,
            }

        _note_extra = (
            " SSH connected but no error log found — MariaDB error logging is disabled (skip_log_error). "
            "Run fix_mariadb_errorlog.py or use the Self-Heal terminal to enable it."
            if (connection.ssh_user and connection.ssh_password)
            else " Configure SSH credentials (SSH Config button) to enable remote log reading."
        )

        # 4. performance_schema.events_errors_summary last-resort
        if not (mysql_is_down and not _is_local_host):
            try:
                fb_engine = create_engine(mysql_url, connect_args={"connect_timeout": 2})
                with fb_engine.connect() as fb_conn:
                    err_rows = fb_conn.execute(text("""
                        SELECT ERROR_NUMBER, ERROR_NAME,
                            SUM_ERROR_RAISED AS count, SUM_ERROR_HANDLED AS handled,
                            FIRST_SEEN, LAST_SEEN
                        FROM performance_schema.events_errors_summary_global_by_error
                        WHERE SUM_ERROR_RAISED > 0 ORDER BY SUM_ERROR_RAISED DESC LIMIT 100
                    """)).fetchall()
                    error_summary_logs = [{
                        "logged":      str(dict(r._mapping).get("LAST_SEEN") or ""),
                        "severity":    "ERROR",
                        "subsystem":   "MySQL",
                        "error_code":  str(dict(r._mapping).get("ERROR_NUMBER", "")),
                        "message":     f"[{dict(r._mapping).get('ERROR_NAME','')}] raised {dict(r._mapping).get('count',0)} times (handled: {dict(r._mapping).get('handled',0)}) — last seen: {dict(r._mapping).get('LAST_SEEN','')}",
                        "status":      "OPEN",
                        "category":    "ERROR",
                        "mysql_level": "Error",
                    } for r in err_rows]
                    return {
                        "status": "success", "source": "performance_schema_errors",
                        "log_path": mysql_error_path or "remote — not accessible",
                        "mysql_down": mysql_is_down, "total": len(error_summary_logs),
                        "summary": build_mysql_log_summary(error_summary_logs),
                        "logs": error_summary_logs,
                        "note": "performance_schema.error_log not available. Showing error summary.",
                    }
            except Exception:
                pass

        return {
            "status": "success", "source": "none",
            "log_path": mysql_error_path or "not found",
            "mysql_down": mysql_is_down, "total": 0,
            "summary": {
                "severities": {"CRITICAL": 0, "ERROR": 0, "WARNING": 0, "INFO": 0},
                "statuses":   {"OPEN": 0, "PENDING": 0, "RESOLVED": 0},
                "categories": {"ERROR": 0, "WARNING": 0, "MESSAGE": 0},
            },
            "logs": [],
            "note": (
                "Error log is not accessible. MariaDB error logging may be disabled (skip_log_error)."
                + _note_extra
                + f" Log path reported by MySQL: {mysql_error_path or 'unknown (log_error is empty)'}"
            ),
        }

    # 5. Read local file
    try:
        lines = tail_file(mysql_error_path, 300)
        logs  = []
        for line in lines:
            line = line.strip()
            if not line:
                continue
            cls = classify_mysql_log_line(line)
            logs.append({
                "severity":    cls["severity"],
                "status":      cls["status"],
                "category":    cls["category"],
                "mysql_level": cls["mysql_level"],
                "message":     line,
            })
        logs = resolve_mysql_log_timeline(logs, mysql_is_down)
        logs.reverse()
        for log in logs:
            log.setdefault("logged", None)
            log.setdefault("subsystem", "MySQL")
        return {
            "status": "success", "source": "file", "log_path": mysql_error_path,
            "mysql_down": mysql_is_down, "total": len(logs), "total_logs": len(logs),
            "summary": build_mysql_log_summary(logs), "logs": logs,
        }
    except Exception as e:
        return {"status": "error", "mysql_down": mysql_is_down,
                "message": str(e), "logs": [], "error_log_path": mysql_error_path}


def _parse_logged_at(value) -> Optional[datetime]:
    """`logged` comes back in a couple of different shapes depending on
    source (performance_schema's own DATE_FORMAT string vs. whatever a raw
    log line's own timestamp looked like) — try the common ones, give up to
    None (never raises) rather than let one unparsable row break filtering
    for every other row."""
    if not value:
        return None
    text_ = str(value).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text_[: len(fmt) + 8], fmt)
        except ValueError:
            continue
    return None


def list_error_logs_filtered(
    conn_id: int, db: Session,
    severity: str = None, search: str = None,
    date_from: str = None, date_to: str = None,
    page: int = 1, page_size: int = 50,
) -> dict:
    """Wraps `get_error_logs` with real server-side filter/sort/pagination —
    same pattern as `mysql_slow_query_service.list_slow_queries_filtered`.
    Doesn't change `get_error_logs` or its source-detection chain at all;
    this only reshapes what's returned from the SAME already-fetched
    (already-bounded — at most ~500 rows) log list, so the frontend never
    has to filter client-side or hold the full response just to show one
    page."""
    response = get_error_logs(conn_id, db)
    all_logs = response.get("logs") or []
    logs = list(all_logs)

    if severity and severity.upper() != "ALL":
        logs = [l for l in logs if (l.get("severity") or "").upper() == severity.upper()]
    if search:
        q = search.strip().lower()
        logs = [l for l in logs if q in (l.get("message") or "").lower() or q in (l.get("subsystem") or "").lower()]
    if date_from or date_to:
        df = _parse_logged_at(date_from) if date_from else None
        dt = _parse_logged_at(date_to) if date_to else None
        def _in_range(l):
            ts = _parse_logged_at(l.get("logged"))
            if ts is None:
                return False
            if df and ts < df:
                return False
            if dt and ts > dt.replace(hour=23, minute=59, second=59):
                return False
            return True
        logs = [l for l in logs if _in_range(l)]

    total_filtered = len(logs)
    page = max(1, page)
    page_size = max(1, min(page_size, 200))
    start = (page - 1) * page_size
    page_logs = logs[start:start + page_size]

    out = dict(response)
    out["logs"] = page_logs
    out["total_filtered"] = total_filtered
    out["total_unfiltered"] = len(all_logs)
    out["page"] = page
    out["page_size"] = page_size
    return out


def analyze_error_with_ai(conn_id: int, message: str, db: Session) -> dict:
    connection = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    diagnostic_context = {}
    if connection:
        diagnostic_context = collect_mysql_diagnostic_context(connection)
    result = analyze_mysql_error(message, diagnostic_context)
    return {"status": "success", "analysis": result}


def run_self_heal(conn_id: int, error_message: str, db: Session) -> dict:
    connection = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not connection:
        raise HTTPException(404, "Connection not found")
    return run_mysql_self_heal(connection=connection, mysql_error_message=error_message)


def get_self_heal_history_data(conn_id: int) -> dict:
    if not os.path.exists(SELF_HEAL_HISTORY_DIR):
        return {"status": "success", "history": []}

    history = []
    for filename in os.listdir(SELF_HEAL_HISTORY_DIR):
        if not filename.endswith(".json"):
            continue
        path = os.path.join(SELF_HEAL_HISTORY_DIR, filename)
        try:
            with open(path, "r", encoding="utf-8") as f:
                record = json.load(f)
            history.append({
                "run_id":       record.get("run_id"),
                "status":       record.get("status"),
                "host":         record.get("host"),
                "action_type":  record.get("action_type"),
                "history_path": path,
                "commands":     record.get("commands", []),
                "logs":         record.get("logs", [])[-20:],
            })
        except Exception:
            continue

    history.sort(key=lambda item: item.get("run_id") or "", reverse=True)
    return {"status": "success", "history": history[:20]}


def analyze_with_groq(
    conn_id: int, logs: list, log_path: str, source: str,
    host: str, database: str, db: Session,
) -> dict:
    connection = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not connection:
        raise HTTPException(404, "Connection not found")

    top_logs = [l for l in logs if l.get("severity") in ("CRITICAL", "ERROR", "WARNING")][:30]
    if not top_logs:
        top_logs = logs[:20]

    formatted = "\n".join([
        f"[{i+1}] [{l.get('severity','?')}] {l.get('logged','?')} — {l.get('message','')[:300]}"
        for i, l in enumerate(top_logs)
    ])

    prompt = f"""You are an Expert Senior MariaDB/MySQL DBA AI assistant.

Analyze these error log entries from a production database server.

Server: {host or connection.host}:{connection.port}
Database: {database or connection.database_name}
Log Source: {source}
Log Path: {log_path or 'unknown'}

Error Log Entries (most critical first):
{formatted}

Return ONLY valid JSON. No markdown. No code blocks.

{{
  "severity": "CRITICAL|ERROR|WARNING|INFO",
  "summary": "Brief 1-2 sentence overview of the database health",
  "root_cause": "Technical root cause explanation",
  "business_impact": "Business/operational impact description",
  "error_patterns": ["pattern1", "pattern2"],
  "fix_steps": ["Step 1: Description of fix", "Step 2: Description of fix"],
  "ssh_commands": ["systemctl status mariadb", "journalctl -xe -u mariadb --no-pager | tail -50"],
  "mysql_commands": ["SHOW PROCESSLIST;", "SHOW GLOBAL STATUS LIKE 'Threads%';"],
  "preventive_measures": ["measure1", "measure2"],
  "estimated_fix_time": "5-10 minutes"
}}"""

    try:
        resp = _groq_client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=2000,
            reasoning_effort="low",
        )
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        analysis = json.loads(raw)
    except json.JSONDecodeError:
        analysis = {
            "severity": "ERROR", "summary": "Could not parse AI response as JSON.",
            "root_cause": raw[:500] if "raw" in dir() else "AI response unavailable",
            "business_impact": "Unknown", "error_patterns": [], "fix_steps": [],
            "ssh_commands": [], "mysql_commands": [], "preventive_measures": [],
            "estimated_fix_time": "Unknown",
        }
    except Exception as e:
        raise HTTPException(500, f"ActMon AI analysis failed: {e}")

    return {"status": "success", "analysis": analysis}


async def create_self_heal_stream(connection: ConnectionMaster, commands: List[str]):
    """Async generator that streams SSH PTY command execution events."""
    ssh_host     = connection.ssh_host or connection.host
    ssh_port     = int(connection.ssh_port or 22)
    ssh_user     = connection.ssh_user
    ssh_password = connection.ssh_password

    if not ssh_user or not ssh_password:
        yield {"type": "error", "msg": "SSH credentials not configured. Use SSH Config to set them."}
        return

    yield {"type": "info", "msg": f"Connecting to {ssh_host}:{ssh_port} as {ssh_user}..."}

    ssh_client = paramiko.SSHClient()
    ssh_client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        await asyncio.to_thread(
            ssh_client.connect,
            hostname=ssh_host, port=ssh_port,
            username=ssh_user, password=ssh_password,
            timeout=10, look_for_keys=False, allow_agent=False,
        )
    except Exception as e:
        yield {"type": "error", "msg": f"SSH connection failed: {e}"}
        return

    yield {"type": "connected", "msg": f"Connected to {ssh_host} as {ssh_user}"}

    loop = asyncio.get_event_loop()
    q: asyncio.Queue = asyncio.Queue()

    def _pty_session():
        def emit(evt):
            loop.call_soon_threadsafe(q.put_nowait, evt)

        def drain(wait=0.4):
            time.sleep(wait)
            buf = b""
            while shell.recv_ready():
                buf += shell.recv(65536)
                time.sleep(0.05)
            return buf.decode("utf-8", errors="ignore")

        def send_wait_marker(cmd_text, idx, timeout=60):
            marker = f"__ACTMON_DONE_{idx}__"
            shell.send(cmd_text + "\n")
            shell.send(f"echo '{marker}'\n")
            deadline = time.time() + timeout
            buf = ""
            while time.time() < deadline:
                if shell.recv_ready():
                    buf += shell.recv(65536).decode("utf-8", errors="ignore")
                    if marker in buf:
                        raw  = buf[:buf.index(marker)]
                        skip = {cmd_text.strip(), f"echo '{marker}'", marker}
                        cleaned = []
                        for ln in raw.split("\n"):
                            s = ln.strip()
                            if s in skip:
                                continue
                            if re.search(r'[\$#]\s*$', s) and len(s) < 60 and (
                                    "root@" in s or ssh_user in s):
                                continue
                            cleaned.append(ln)
                        return "\n".join(cleaned).strip()
                time.sleep(0.1)
            return buf.strip()

        try:
            shell = ssh_client.invoke_shell(width=220, height=50)
            drain(1.5)

            emit({"type": "info", "msg": "Escalating privileges via su - root..."})
            shell.send("su - root\n")
            time.sleep(1.5)
            out = drain(0.5)

            got_root = False
            if "assword" in out:
                shell.send(ssh_password + "\n")
                time.sleep(2.5)
                out2 = drain(0.5)
                if "#" in out2 or "root@" in out2.lower():
                    got_root = True
                    emit({"type": "stdout", "data": "✓ Root shell obtained via su"})
                else:
                    shell.send("exit\n")
                    drain(0.5)
                    emit({"type": "stderr", "data": "su failed — wrong root password or su not allowed"})
            elif "#" in out or "root@" in out.lower():
                got_root = True
                emit({"type": "stdout", "data": "✓ Already root"})

            root_method = "su" if got_root else None

            if not got_root:
                emit({"type": "info", "msg": "Trying sudo -S fallback..."})
                sq       = ssh_password.replace("'", "'\\''")
                test_out = send_wait_marker(f"echo '{sq}' | sudo -S id 2>/dev/null", 9999, timeout=10)
                if "uid=0" in test_out or "root" in test_out:
                    root_method = "sudo"
                    emit({"type": "stdout", "data": "✓ sudo -S works — running commands with sudo"})
                else:
                    emit({"type": "error", "msg": (
                        "Cannot escalate to root. "
                        "Neither 'su - root' nor 'sudo -S' works for this user."
                    )})
                    loop.call_soon_threadsafe(q.put_nowait, None)
                    return

            for i, cmd in enumerate(commands):
                emit({"type": "cmd", "cmd": cmd})
                if root_method == "su":
                    run_cmd = cmd
                else:
                    sq       = ssh_password.replace("'", "'\\''")
                    safe_cmd = cmd.replace("'", "'\\''")
                    run_cmd  = f"echo '{sq}' | sudo -S bash -c '{safe_cmd}' 2>&1"

                result = send_wait_marker(run_cmd, i, timeout=90)
                if result:
                    lower = result.lower()
                    if any(k in lower for k in ("permission denied", "cannot create", "error:", "failed to")):
                        emit({"type": "stderr", "data": result})
                    else:
                        emit({"type": "stdout", "data": result})
                else:
                    emit({"type": "stdout", "data": "(completed — no output)"})

            shell.send("exit\n")
            drain(0.5)

        except Exception as exc:
            emit({"type": "error", "msg": f"PTY session error: {exc}"})
        finally:
            try: ssh_client.close()
            except: pass
            loop.call_soon_threadsafe(q.put_nowait, None)

    t = threading.Thread(target=_pty_session, daemon=True)
    t.start()

    while True:
        evt = await q.get()
        if evt is None:
            break
        yield evt

    yield {"type": "done", "msg": "All commands executed"}
