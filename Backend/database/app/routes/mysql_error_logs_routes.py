
from fastapi import (
    APIRouter,
    Depends,
    HTTPException
)

from sqlalchemy.orm import Session

from sqlalchemy import (
    create_engine,
    text
)

from urllib.parse import (
    quote_plus
)

from pydantic import (
    BaseModel
)

from app.database.connection import (
    SessionLocal
)

from app.models.connection_model import (
    ConnectionMaster
)

from app.services.mysql_ai_analysis import (
    analyze_mysql_error
)

from app.services.mysql_self_heal_service import (
    run_mysql_self_heal
)

import os
import json
import re
import socket
import asyncio
import time
import threading
import paramiko
from fastapi.responses import StreamingResponse
from typing import List, Optional
from groq import Groq
from dotenv import load_dotenv

load_dotenv()
_groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))


router = APIRouter(

    prefix="/api/v1/connections/mysql",

    tags=["MySQL Error Logs"]

)


# =====================================================
# DB SESSION
# =====================================================

def get_db():

    db = SessionLocal()

    try:

        yield db

    finally:

        db.close()


# =====================================================
# AI PAYLOAD
# =====================================================

class ErrorPayload(BaseModel):

    message: str


# =====================================================
# SELF HEAL PAYLOAD
# =====================================================

class SelfHealPayload(BaseModel):

    error_message: str

    affected_file: str = ""

    action_type: str = ""

    target_variable: str = ""

    target_value: str = ""


class AnalyzeGroqPayload(BaseModel):

    logs: List[dict] = []
    log_path: str = ""
    source: str = ""
    host: str = ""
    database: str = ""


class SelfHealStreamPayload(BaseModel):

    commands: List[str] = []


# =====================================================
# MYSQL LOG CLASSIFICATION
# =====================================================

MYSQL_LOG_LEVEL_PATTERN = re.compile(
    r"\[(ERROR|WARNING|NOTE|INFO|INFORMATION|SYSTEM)\]",
    re.IGNORECASE
)

SELF_HEAL_HISTORY_DIR = os.path.join(
    os.path.dirname(
        os.path.dirname(__file__)
    ),
    "data",
    "mysql_self_heal_history"
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
    r"\berror\b",
    r"\bfailed\b",
    r"\bfailure\b",
    r"\bdenied\b",
    r"\bnot found\b",
    r"\bunknown variable\b",
    r"\bunable to\b",
    r"\bcannot\b",
    r"\bcan't\b",
]

WARNING_PATTERNS = [
    r"\bwarning\b",
    r"\bdeprecated\b",
    r"\bunsafe\b",
    r"\bretry\b",
    r"\btimeout\b",
]

RESOLVED_PATTERNS = [
    r"\binitialization has ended\b",
    r"\bready for connections\b",
    r"\bcrash recovery finished\b",
    r"\bxa crash recovery finished\b",
    r"\bshutdown complete\b",
    r"\bcompleted\b",
    r"\bsuccessfully\b",
]

HEALTHY_MYSQL_STATE_PATTERNS = [
    r"\binitialization has ended\b",
    r"\bready for connections\b",
    r"\bserver is operational\b",
]

NORMAL_SYSTEM_PATTERNS = [
    r"\binitialization has started\b",
    r"\binitialization has ended\b",
    r"\bcrash recovery finished\b",
    r"\bxa crash recovery finished\b",
    r"\bready for connections\b",
]

PENDING_PATTERNS = [
    r"\binitialization has started\b",
    r"\bstarting\b",
    r"\bretry\b",
    r"\bwaiting\b",
    r"\brecovering\b",
]

INFO_HINTS = [
    r"\binitialization has started\b",
    r"\binitialization has ended\b",
    r"\bready for connections\b",
    r"\bstarting\b",
    r"\bstarted\b",
    r"\bended\b",
    r"\bcompleted\b",
    r"\bplugin\b",
]


_SSH_CONNECT_TIMEOUT = 3  # fast fail when host is unreachable


def _read_file_via_ssh(host: str, port: int, username: str, password: str, filepath: str):
    """Read a remote file via SSH cat. Returns (content_str, error_str)."""
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


def _ssh_read_errorlog(host: str, port: int, username: str, password: str,
                       extra_paths: list = None):
    """
    Connect once via SSH, then try multiple file paths and commands.
    Returns (content_str, source_label, path_used) or (None, None, None).
    """
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
            _, out, err = ssh.exec_command(cmd, timeout=20)
            return out.read().decode("utf-8", errors="ignore")
        except Exception:
            return ""

    try:
        # Discover .err files dynamically
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
        file_paths = list(dict.fromkeys(file_paths))  # deduplicate

        for fp in file_paths:
            content = run(f"cat '{fp}' 2>/dev/null")
            if content and len(content.strip()) > 10:
                return content, "ssh_file", fp

        # No file found — try journalctl / syslog
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
            # Filter out journalctl header hints
            lines = [l for l in content.splitlines()
                     if l.strip() and not l.startswith("Hint:") and not l.startswith("--")]
            if len(lines) > 2:
                return "\n".join(lines), label, label

        return None, None, None
    finally:
        try: ssh.close()
        except: pass


def _parse_ssh_log_lines(lines: list, mysql_is_down: bool) -> list:
    """Convert raw log lines (file or journalctl format) to log dicts."""
    logs = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        cls = classify_mysql_log_line(line)
        # Try ISO timestamp first (journalctl --output=short-iso)
        ts = re.search(r'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}', line)
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


def tail_file(filepath, n=300):

    try:

        with open(filepath, "rb") as f:

            try:

                f.seek(0, os.SEEK_END)

            except ValueError:

                return []

            position = f.tell()

            lines = []

            buffer = bytearray()

            chunk_size = 4096

            while position > 0 and len(lines) <= n:

                read_size = min(chunk_size, position)

                position -= read_size

                f.seek(position)

                chunk = f.read(read_size)

                buffer = chunk + buffer

                lines = buffer.split(b"\n")

            last_lines = lines[-n:]

            return [
                line.decode("utf-8", errors="ignore")
                for line in last_lines
            ]

    except Exception as e:

        print(f"Error tailing file {filepath}: {e}")

        return []


def _matches_any(value, patterns):

    return any(
        re.search(pattern, value, re.IGNORECASE)
        for pattern in patterns
    )


def classify_mysql_log_line(line):

    normalized = line.strip()
    lower_line = normalized.lower()

    mysql_level = None

    level_match = MYSQL_LOG_LEVEL_PATTERN.search(
        normalized
    )

    if level_match:

        mysql_level = level_match.group(1).upper()

    if mysql_level in [
        "SYSTEM",
        "NOTE",
        "INFO",
        "INFORMATION"
    ] and _matches_any(
        lower_line,
        NORMAL_SYSTEM_PATTERNS
    ):

        severity = "INFO"

    elif _matches_any(
        lower_line,
        CRITICAL_PATTERNS
    ):

        severity = "CRITICAL"

    elif mysql_level == "ERROR":

        severity = "ERROR"

    elif mysql_level == "WARNING":

        severity = "WARNING"

    elif mysql_level in [
        "SYSTEM",
        "NOTE",
        "INFO",
        "INFORMATION"
    ]:

        severity = "INFO"

    elif _matches_any(
        lower_line,
        ERROR_PATTERNS
    ) and not _matches_any(
        lower_line,
        INFO_HINTS
    ):

        severity = "ERROR"

    elif _matches_any(
        lower_line,
        WARNING_PATTERNS
    ):

        severity = "WARNING"

    else:

        severity = "INFO"

    if severity in [
        "CRITICAL",
        "ERROR"
    ]:

        status = "OPEN"

    elif _matches_any(
        lower_line,
        RESOLVED_PATTERNS
    ):

        status = "RESOLVED"

    elif severity == "WARNING" or _matches_any(
        lower_line,
        PENDING_PATTERNS
    ):

        status = "PENDING"

    else:

        status = "RESOLVED"

    if severity in [
        "CRITICAL",
        "ERROR"
    ]:

        category = "ERROR"

    elif severity == "WARNING":

        category = "WARNING"

    else:

        category = "MESSAGE"

    return {

        "severity": severity,

        "status": status,

        "category": category,

        "mysql_level": mysql_level or "INFO"

    }


def resolve_mysql_log_timeline(logs, mysql_is_down=False):

    latest_healthy_index = None

    for index, log in enumerate(logs):

        message = log.get(
            "message",
            ""
        ).lower()

        if (
            log.get("severity") == "INFO"
            and _matches_any(
                message,
                HEALTHY_MYSQL_STATE_PATTERNS
            )
        ):

            latest_healthy_index = index

    for index, log in enumerate(logs):

        message = log.get(
            "message",
            ""
        ).lower()

        if _matches_any(
            message,
            RESOLVED_PATTERNS
        ):

            log["status"] = "RESOLVED"

        if (
            latest_healthy_index is not None
            and index < latest_healthy_index
            and log.get("severity") in [
                "CRITICAL",
                "ERROR",
                "WARNING"
            ]
        ):

            log["status"] = "RESOLVED"

            log["resolution_hint"] = (
                "A later MySQL healthy/startup message was found."
            )

        if (
            mysql_is_down
            and index > (
                latest_healthy_index
                if latest_healthy_index is not None
                else -1
            )
            and log.get("severity") in [
                "CRITICAL",
                "ERROR"
            ]
        ):

            log["status"] = "OPEN"

    return logs


def build_mysql_log_summary(logs):

    severities = {
        "CRITICAL": 0,
        "ERROR": 0,
        "WARNING": 0,
        "INFO": 0
    }

    statuses = {
        "OPEN": 0,
        "PENDING": 0,
        "RESOLVED": 0
    }

    categories = {
        "ERROR": 0,
        "WARNING": 0,
        "MESSAGE": 0
    }

    for log in logs:

        severities[log["severity"]] = (
            severities.get(
                log["severity"],
                0
            )
            + 1
        )

        statuses[log["status"]] = (
            statuses.get(
                log["status"],
                0
            )
            + 1
        )

        categories[log["category"]] = (
            categories.get(
                log["category"],
                0
            )
            + 1
        )

    return {
        "severities": severities,
        "statuses": statuses,
        "categories": categories
    }


def _safe_fetch_all(conn, sql):

    try:

        result = conn.execute(
            text(sql)
        )

        rows = result.fetchall()

        return [
            dict(row._mapping)
            for row in rows
        ]

    except Exception as e:

        return {
            "error": str(e)
        }


def collect_mysql_diagnostic_context(connection):

    encoded_password = quote_plus(
        connection.password
    )

    mysql_url = (

        f"mysql+pymysql://"

        f"{connection.username}:"

        f"{encoded_password}@"

        f"{connection.host}:"

        f"{connection.port}/"

        f"{connection.database_name}"

    )

    context = {
        "connection_host": connection.host,
        "database": connection.database_name,
        "note": "Live point-in-time diagnostics. Historical CPU deltas require stored snapshots."
    }

    try:

        engine = create_engine(

            mysql_url,

            connect_args={

                "connect_timeout": 2,

                "read_timeout": 2,

                "write_timeout": 2

            }

        )

        with engine.connect() as conn:

            context["processlist"] = _safe_fetch_all(
                conn,
                """
                SELECT
                    ID,
                    USER,
                    HOST,
                    DB,
                    COMMAND,
                    TIME,
                    STATE,
                    LEFT(INFO, 500) AS INFO
                FROM information_schema.PROCESSLIST
                WHERE COMMAND <> 'Sleep'
                ORDER BY TIME DESC
                LIMIT 10
                """
            )

            context["largest_tables_mb"] = _safe_fetch_all(
                conn,
                """
                SELECT
                    TABLE_SCHEMA,
                    TABLE_NAME,
                    ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) AS SIZE_MB,
                    TABLE_ROWS
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema')
                ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC
                LIMIT 10
                """
            )

            context["status_counters"] = _safe_fetch_all(
                conn,
                """
                SHOW GLOBAL STATUS
                WHERE Variable_name IN (
                    'Threads_running',
                    'Threads_connected',
                    'Questions',
                    'Slow_queries',
                    'Created_tmp_disk_tables',
                    'Innodb_row_lock_waits',
                    'Innodb_buffer_pool_reads'
                )
                """
            )

            context["top_statement_digests"] = _safe_fetch_all(
                conn,
                """
                SELECT
                    SCHEMA_NAME,
                    DIGEST_TEXT,
                    COUNT_STAR,
                    ROUND(SUM_TIMER_WAIT / 1000000000000, 2) AS TOTAL_SECONDS,
                    ROUND(AVG_TIMER_WAIT / 1000000000000, 4) AS AVG_SECONDS,
                    SUM_ROWS_EXAMINED,
                    SUM_ROWS_SENT
                FROM performance_schema.events_statements_summary_by_digest
                WHERE DIGEST_TEXT IS NOT NULL
                ORDER BY SUM_TIMER_WAIT DESC
                LIMIT 10
                """
            )

    except Exception as e:

        context["collection_error"] = str(e)

    return context


# =====================================================
# GET MYSQL ERROR LOGS
# =====================================================

@router.get("/{conn_id}/error-logs")
def get_error_logs(

    conn_id: int,

    db: Session = Depends(get_db)

):

    connection = db.query(
        ConnectionMaster
    ).filter(

        ConnectionMaster.id == conn_id

    ).first()

    if not connection:

        raise HTTPException(

            status_code=404,

            detail="Connection not found"

        )

    encoded_password = quote_plus(
        connection.password
    )

    mysql_url = (

        f"mysql+pymysql://"

        f"{connection.username}:"

        f"{encoded_password}@"

        f"{connection.host}:"

        f"{connection.port}/"

        f"{connection.database_name}"

    )

    mysql_error_path = None

    mysql_is_down = False

    _is_local_host = connection.host in ("localhost", "127.0.0.1", "::1", socket.gethostname())

    # =================================================
    # TRY PERFORMANCE SCHEMA ERROR LOG FIRST
    # Works for remote MySQL (8.0.22+) without file access
    # =================================================

    try:

        ps_engine = create_engine(

            mysql_url,

            connect_args={
                "connect_timeout": 2,
                "read_timeout":    5,
                "write_timeout":   5,
            }

        )

        with ps_engine.connect() as ps_conn:

            ps_rows = ps_conn.execute(text("""
                SELECT
                    DATE_FORMAT(LOGGED, '%Y-%m-%d %H:%i:%s') AS logged,
                    THREAD_ID,
                    PRIO,
                    IFNULL(ERROR_CODE,'')   AS error_code,
                    IFNULL(SUBSYSTEM,'MySQL') AS subsystem,
                    DATA
                FROM performance_schema.error_log
                ORDER BY LOGGED DESC
                LIMIT 500
            """)).fetchall()

        logs = []

        for row in ps_rows:

            d    = dict(row._mapping)
            prio = (d.get("PRIO") or "Note").strip()
            data = d.get("DATA") or ""

            if prio == "Error":
                sev = "CRITICAL" if any(
                    p in data.lower() for p in ["crash","fatal","abort","corrupt","assertion"]
                ) else "ERROR"
            elif prio == "Warning":
                sev = "WARNING"
            elif prio == "System":
                sev = "CRITICAL" if any(
                    p in data.lower() for p in ["aborting","crash","fatal"]
                ) else "INFO"
            else:
                sev = "INFO"

            logs.append({
                "logged":     d.get("logged"),
                "severity":   sev,
                "subsystem":  d.get("subsystem","MySQL"),
                "error_code": d.get("error_code",""),
                "message":    data,
                "status":     "OPEN" if sev in ("CRITICAL","ERROR") else "RESOLVED",
                "category":   "ERROR" if sev in ("CRITICAL","ERROR") else ("WARNING" if sev == "WARNING" else "MESSAGE"),
                "mysql_level": prio,
            })

        return {
            "status":      "success",
            "source":      "performance_schema",
            "log_path":    None,
            "mysql_down":  False,
            "total":       len(logs),
            "summary":     build_mysql_log_summary(logs),
            "logs":        logs,
        }

    except Exception:

        pass  # Fall through to file-based approach

    # =================================================
    # TRY GET LOG PATH FROM MYSQL
    # =================================================

    try:

        engine = create_engine(

            mysql_url,

            connect_args={

                "connect_timeout": 2,

                "read_timeout": 2,

                "write_timeout": 2

            }

        )

        with engine.connect() as conn:

            result = conn.execute(

                text("""

                    SHOW VARIABLES
                    LIKE 'log_error'

                """)

            ).fetchone()

        mysql_error_path = result[1]

        print(
            "MYSQL RAW PATH =",
            mysql_error_path
        )

        # =============================================
        # FIX RELATIVE PATH
        # =============================================

        if mysql_error_path.startswith(".\\"):

            mysql_error_path = os.path.join(

                r"C:\ProgramData\MySQL\MySQL Server 8.0\Data",

                mysql_error_path.replace(
                    ".\\",
                    ""
                )

            )

        print(
            "FINAL PATH =",
            mysql_error_path
        )

    except Exception as e:

        print(
            f"MySQL connection failed: {str(e)}"
        )

        mysql_is_down = True

        # Only use local Windows fallback paths when the connection host is localhost
        _is_local_host = connection.host in ("localhost", "127.0.0.1", "::1", socket.gethostname())

        if _is_local_host:
            # =============================================
            # FALLBACK PATHS (local Windows MySQL only)
            # =============================================

            fallback_paths = [
                r"C:\ProgramData\MySQL\MySQL Server 8.0\Data\mysql_error.log",
                r"C:\ProgramData\MySQL\MySQL Server 8.0\Data\error.log",
            ]

            hostname = socket.gethostname()
            fallback_paths.insert(0, rf"C:\ProgramData\MySQL\MySQL Server 8.0\Data\{hostname}.err")

            for path in fallback_paths:
                if os.path.exists(path):
                    mysql_error_path = path
                    print(f"FALLBACK PATH FOUND = {mysql_error_path}")
                    break

            # Auto-discover .err files in local MySQL data dir
            if not mysql_error_path:
                data_dir = r"C:\ProgramData\MySQL\MySQL Server 8.0\Data"
                if os.path.exists(data_dir):
                    for f in os.listdir(data_dir):
                        if f.endswith(".err") or f.endswith(".log"):
                            mysql_error_path = os.path.join(data_dir, f)
                            break


    # =================================================
    # FILE VALIDATION
    # =================================================

    if (

        not mysql_error_path

        or

        not os.path.exists(mysql_error_path)

    ):

        # ─── SSH Fallback (single connection for all attempts) ────────────────
        _ssh_logs = None
        _ssh_source_label = "ssh_file"
        _ssh_path_used = None

        if connection.ssh_user and connection.ssh_password:
            _ssh_host = connection.ssh_host or connection.host
            _ssh_port = connection.ssh_port or 22
            # Extra paths from what MySQL reported (before it went down)
            _extra = []
            if mysql_error_path:
                _extra.append(mysql_error_path)
                if not mysql_error_path.startswith('/'):
                    _extra.append('/var/lib/mysql/' + mysql_error_path.lstrip('./\\'))

            _content, _ssh_source_label, _ssh_path_used = _ssh_read_errorlog(
                _ssh_host, _ssh_port,
                connection.ssh_user, connection.ssh_password,
                extra_paths=_extra
            )
            if _content:
                _raw_lines = [l for l in _content.splitlines()[-500:] if l.strip()]
                _ssh_logs = _parse_ssh_log_lines(_raw_lines, mysql_is_down)

        if _ssh_logs is not None:
            _note = None
            if not _ssh_logs:
                _note = "SSH log retrieved but contained no parseable entries."
            return {
                "status":     "success",
                "source":     _ssh_source_label,
                "log_path":   _ssh_path_used,
                "mysql_down": mysql_is_down,
                "total":      len(_ssh_logs),
                "summary":    build_mysql_log_summary(_ssh_logs),
                "logs":       _ssh_logs,
                "note":       _note,
                "ssh_host":   connection.ssh_host or connection.host,
            }
        elif connection.ssh_user and connection.ssh_password:
            _note_extra = (
                " SSH connected but no error log found — "
                "MariaDB error logging is disabled on this server (skip_log_error is set). "
                "Run fix_mariadb_errorlog.py or use the Self-Heal terminal to enable it."
            )
        else:
            _note_extra = " Configure SSH credentials (SSH Config button) to enable remote log reading."
        # ─────────────────────────────────────────────────────────────────────

        # Try performance_schema.events_errors_summary as a last-resort fallback
        # Skip entirely if MySQL is already confirmed down on a remote host
        if not (mysql_is_down and not _is_local_host):
            try:
                fb_engine = create_engine(mysql_url, connect_args={"connect_timeout": 2})

                with fb_engine.connect() as fb_conn:

                    err_rows = fb_conn.execute(text("""
                        SELECT
                            ERROR_NUMBER,
                            ERROR_NAME,
                            SUM_ERROR_RAISED AS count,
                            SUM_ERROR_HANDLED AS handled,
                            FIRST_SEEN,
                            LAST_SEEN
                        FROM performance_schema.events_errors_summary_global_by_error
                        WHERE SUM_ERROR_RAISED > 0
                        ORDER BY SUM_ERROR_RAISED DESC
                        LIMIT 100
                    """)).fetchall()

                    error_summary_logs = []

                    for row in err_rows:
                        d = dict(row._mapping)
                        error_summary_logs.append({
                            "logged":      str(d.get("LAST_SEEN") or ""),
                            "severity":    "ERROR",
                            "subsystem":   "MySQL",
                            "error_code":  str(d.get("ERROR_NUMBER", "")),
                            "message":     f"[{d.get('ERROR_NAME','')}] raised {d.get('count',0)} times (handled: {d.get('handled',0)}) — last seen: {d.get('LAST_SEEN','')}",
                            "status":      "OPEN",
                            "category":    "ERROR",
                            "mysql_level": "Error",
                        })

                    return {
                        "status":     "success",
                        "source":     "performance_schema_errors",
                        "log_path":   mysql_error_path or "remote — not accessible",
                        "mysql_down": mysql_is_down,
                        "total":      len(error_summary_logs),
                        "summary":    build_mysql_log_summary(error_summary_logs),
                        "logs":       error_summary_logs,
                        "note":       "performance_schema.error_log not available on this MySQL version. Showing error summary from events_errors_summary_global_by_error.",
                    }

            except Exception:
                pass

        return {

            "status":     "success",
            "source":     "none",
            "log_path":   mysql_error_path or "not found",
            "mysql_down": mysql_is_down,
            "total":      0,

            "summary": {
                "severities": {"CRITICAL": 0, "ERROR": 0, "WARNING": 0, "INFO": 0},
                "statuses":   {"OPEN": 0, "PENDING": 0, "RESOLVED": 0},
                "categories": {"ERROR": 0, "WARNING": 0, "MESSAGE": 0},
            },

            "logs": [],

            "note": (
                "Error log is not accessible. "
                "MariaDB error logging may be disabled on this server (skip_log_error is set). "
                + _note_extra
                + f" Log path reported by MySQL: {mysql_error_path or 'unknown (log_error is empty)'}"
            ),

        }

    # =================================================
    # READ LOG FILE
    # =================================================

    try:

        lines = tail_file(mysql_error_path, 300)

        logs = []

        for line in lines:

            line = line.strip()

            if not line:

                continue

            classification = classify_mysql_log_line(
                line
            )

            logs.append({

                "severity": classification["severity"],

                "status": classification["status"],

                "category": classification["category"],

                "mysql_level": classification["mysql_level"],

                "message": line

            })

        logs = resolve_mysql_log_timeline(
            logs,
            mysql_is_down
        )

        logs.reverse()

        # Normalize logs to include logged/subsystem fields
        for log in logs:
            if "logged" not in log:
                log["logged"] = None
            if "subsystem" not in log:
                log["subsystem"] = "MySQL"

        return {

            "status":     "success",
            "source":     "file",
            "log_path":   mysql_error_path,
            "mysql_down": mysql_is_down,
            "total":      len(logs),
            "total_logs": len(logs),

            "summary": build_mysql_log_summary(
                logs
            ),

            "logs": logs

        }

    except Exception as e:

        return {

            "status": "error",

            "mysql_down": mysql_is_down,

            "message": str(e),

            "logs": [],

            "error_log_path": mysql_error_path

        }


# =====================================================
# AI MYSQL ERROR ANALYSIS
# =====================================================

@router.post("/{conn_id}/analyze-error")
async def analyze_error(

    conn_id: int,

    payload: ErrorPayload,

    db: Session = Depends(get_db)

):

    try:

        connection = db.query(
            ConnectionMaster
        ).filter(

            ConnectionMaster.id == conn_id

        ).first()

        diagnostic_context = {}

        if connection:

            diagnostic_context = collect_mysql_diagnostic_context(
                connection
            )

        result = analyze_mysql_error(
            payload.message,
            diagnostic_context
        )

        return {

            "status": "success",

            "analysis": result

        }

    except Exception as e:

        raise HTTPException(

            status_code=500,

            detail=str(e)

        )


# =====================================================
# MYSQL SELF HEAL ENDPOINT
# =====================================================

@router.post("/{conn_id}/self-heal")
async def self_heal_error(

    conn_id: int,

    payload: SelfHealPayload,

    db: Session = Depends(get_db)

):

    connection = db.query(
        ConnectionMaster
    ).filter(

        ConnectionMaster.id == conn_id

    ).first()

    if not connection:

        raise HTTPException(

            status_code=404,

            detail="Connection not found"

        )

    try:

        result = run_mysql_self_heal(

            connection=connection,

            mysql_error_message=payload.error_message

        )

        return result

    except Exception as e:

        raise HTTPException(

            status_code=500,

            detail=str(e)

        )


@router.get("/{conn_id}/self-heal-history")
def get_self_heal_history(

    conn_id: int

):

    if not os.path.exists(
        SELF_HEAL_HISTORY_DIR
    ):

        return {
            "status": "success",
            "history": []
        }

    history = []

    for filename in os.listdir(
        SELF_HEAL_HISTORY_DIR
    ):

        if not filename.endswith(".json"):

            continue

        path = os.path.join(
            SELF_HEAL_HISTORY_DIR,
            filename
        )

        try:

            with open(
                path,
                "r",
                encoding="utf-8"
            ) as f:

                record = json.load(f)

            history.append({
                "run_id": record.get("run_id"),
                "status": record.get("status"),
                "host": record.get("host"),
                "action_type": record.get("action_type"),
                "history_path": path,
                "commands": record.get("commands", []),
                "logs": record.get("logs", [])[-20:]
            })

        except Exception:

            continue

    history.sort(
        key=lambda item: item.get("run_id") or "",
        reverse=True
    )

    return {
        "status": "success",
        "history": history[:20]
    }


# =====================================================
# GROQ AI ERROR ANALYSIS
# =====================================================

@router.post("/{conn_id}/analyze-groq")
async def analyze_groq_errors(
    conn_id: int,
    payload: AnalyzeGroqPayload,
    db: Session = Depends(get_db)
):
    connection = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not connection:
        raise HTTPException(status_code=404, detail="Connection not found")

    top_logs = [
        l for l in payload.logs
        if l.get("severity") in ("CRITICAL", "ERROR", "WARNING")
    ][:30]

    if not top_logs:
        top_logs = payload.logs[:20]

    formatted = "\n".join([
        f"[{i+1}] [{l.get('severity','?')}] {l.get('logged','?')} — {l.get('message','')[:300]}"
        for i, l in enumerate(top_logs)
    ])

    prompt = f"""You are an Expert Senior MariaDB/MySQL DBA AI assistant.

Analyze these error log entries from a production database server.

Server: {payload.host or connection.host}:{connection.port}
Database: {payload.database or connection.database_name}
Log Source: {payload.source}
Log Path: {payload.log_path or 'unknown'}

Error Log Entries (most critical first):
{formatted}

Return ONLY valid JSON. No markdown. No code blocks.

{{
  "severity": "CRITICAL|ERROR|WARNING|INFO",
  "summary": "Brief 1-2 sentence overview of the database health",
  "root_cause": "Technical root cause explanation",
  "business_impact": "Business/operational impact description",
  "error_patterns": ["pattern1", "pattern2"],
  "fix_steps": [
    "Step 1: Description of fix",
    "Step 2: Description of fix"
  ],
  "ssh_commands": [
    "systemctl status mariadb",
    "journalctl -xe -u mariadb --no-pager | tail -50"
  ],
  "mysql_commands": [
    "SHOW PROCESSLIST;",
    "SHOW GLOBAL STATUS LIKE 'Threads%';"
  ],
  "preventive_measures": ["measure1", "measure2"],
  "estimated_fix_time": "5-10 minutes"
}}"""

    try:
        resp = _groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=2000,
        )
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        analysis = json.loads(raw)
    except json.JSONDecodeError:
        analysis = {
            "severity": "ERROR",
            "summary": "Could not parse AI response as JSON.",
            "root_cause": raw[:500] if "raw" in dir() else "AI response unavailable",
            "business_impact": "Unknown",
            "error_patterns": [],
            "fix_steps": [],
            "ssh_commands": [],
            "mysql_commands": [],
            "preventive_measures": [],
            "estimated_fix_time": "Unknown",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Groq analysis failed: {e}")

    return {"status": "success", "analysis": analysis}


# =====================================================
# SELF-HEAL STREAM (SSE)
# =====================================================

@router.post("/{conn_id}/self-heal-stream")
async def self_heal_stream(
    conn_id: int,
    payload: SelfHealStreamPayload,
    db: Session = Depends(get_db)
):
    connection = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()

    if not connection:
        async def _err():
            yield f"data: {json.dumps({'type': 'error', 'msg': 'Connection not found'})}\n\n"
        return StreamingResponse(_err(), media_type="text/event-stream")

    ssh_host     = connection.ssh_host or connection.host
    ssh_port     = int(connection.ssh_port or 22)
    ssh_user     = connection.ssh_user
    ssh_password = connection.ssh_password
    commands     = [c.strip() for c in payload.commands if c.strip()]

    async def generate():
        if not ssh_user or not ssh_password:
            yield f"data: {json.dumps({'type': 'error', 'msg': 'SSH credentials not configured. Use SSH Config to set them.'})}\n\n"
            return

        yield f"data: {json.dumps({'type': 'info', 'msg': f'Connecting to {ssh_host}:{ssh_port} as {ssh_user}...'})}\n\n"

        ssh_client = paramiko.SSHClient()
        ssh_client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

        try:
            await asyncio.to_thread(
                ssh_client.connect,
                hostname=ssh_host, port=ssh_port,
                username=ssh_user, password=ssh_password,
                timeout=10, look_for_keys=False, allow_agent=False
            )
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'msg': f'SSH connection failed: {e}'})}\n\n"
            return

        yield f"data: {json.dumps({'type': 'connected', 'msg': f'Connected to {ssh_host} as {ssh_user}'})}\n\n"

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
                """Send cmd then a sentinel echo; return text between them (cleaned)."""
                marker = f"__ACTMON_DONE_{idx}__"
                shell.send(cmd_text + "\n")
                shell.send(f"echo '{marker}'\n")
                deadline = time.time() + timeout
                buf = ""
                while time.time() < deadline:
                    if shell.recv_ready():
                        buf += shell.recv(65536).decode("utf-8", errors="ignore")
                        if marker in buf:
                            raw = buf[:buf.index(marker)]
                            lines = raw.split("\n")
                            skip = {cmd_text.strip(), f"echo '{marker}'", marker}
                            cleaned = []
                            for ln in lines:
                                s = ln.strip()
                                # Skip terminal prompt lines and echoed commands
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
                drain(1.5)  # absorb login banner

                # ── Attempt 1: su - root ────────────────────────────────────────
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
                    # ── Attempt 2: sudo -S ──────────────────────────────────────
                    emit({"type": "info", "msg": "Trying sudo -S fallback..."})
                    sq = ssh_password.replace("'", "'\\''")  # escape single quotes
                    test_out = send_wait_marker(
                        f"echo '{sq}' | sudo -S id 2>/dev/null", 9999, timeout=10
                    )
                    if "uid=0" in test_out or "root" in test_out:
                        root_method = "sudo"
                        emit({"type": "stdout", "data": "✓ sudo -S works — running commands with sudo"})
                    else:
                        emit({"type": "error", "msg": (
                            "Cannot escalate to root. "
                            "Neither 'su - root' nor 'sudo -S' works for this user. "
                            "Add suyash to sudoers or use the correct root password."
                        )})
                        loop.call_soon_threadsafe(q.put_nowait, None)
                        return

                # ── Run each command ────────────────────────────────────────────
                for i, cmd in enumerate(commands):
                    emit({"type": "cmd", "cmd": cmd})

                    if root_method == "su":
                        # We are inside the root shell — run directly
                        run_cmd = cmd
                    else:
                        # Not in root shell — prefix each command with sudo -S
                        sq = ssh_password.replace("'", "'\\''")
                        safe_cmd = cmd.replace("'", "'\\''")
                        run_cmd = f"echo '{sq}' | sudo -S bash -c '{safe_cmd}' 2>&1"

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
                try:
                    ssh_client.close()
                except Exception:
                    pass
                loop.call_soon_threadsafe(q.put_nowait, None)  # sentinel

        t = threading.Thread(target=_pty_session, daemon=True)
        t.start()

        while True:
            evt = await q.get()
            if evt is None:
                break
            yield f"data: {json.dumps(evt)}\n\n"

        yield f"data: {json.dumps({'type': 'done', 'msg': 'All commands executed'})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        }
    )
