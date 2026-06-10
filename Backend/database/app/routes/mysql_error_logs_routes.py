
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

                "connect_timeout": 3,

                "read_timeout": 3,

                "write_timeout": 3

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

    # =================================================
    # TRY PERFORMANCE SCHEMA ERROR LOG FIRST
    # Works for remote MySQL (8.0.22+) without file access
    # =================================================

    try:

        ps_engine = create_engine(

            mysql_url,

            connect_args={
                "connect_timeout": 4,
                "read_timeout":    8,
                "write_timeout":   8,
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

                "connect_timeout": 3,

                "read_timeout": 3,

                "write_timeout": 3

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

        # =============================================
        # FALLBACK PATHS
        # =============================================

        fallback_paths = [

            r"C:\ProgramData\MySQL\MySQL Server 8.0\Data\mysql_error.log",

            r"C:\ProgramData\MySQL\MySQL Server 8.0\Data\error.log",

        ]

        hostname = socket.gethostname()

        fallback_paths.insert(

            0,

            rf"C:\ProgramData\MySQL\MySQL Server 8.0\Data\{hostname}.err"

        )

        for path in fallback_paths:

            if os.path.exists(path):

                mysql_error_path = path

                print(
                    f"FALLBACK PATH FOUND = {mysql_error_path}"
                )

                break

        # =============================================
        # AUTO DISCOVER LOG FILE
        # =============================================

        if not mysql_error_path:

            data_dir = (

                r"C:\ProgramData\MySQL\MySQL Server 8.0\Data"

            )

            if os.path.exists(data_dir):

                for f in os.listdir(data_dir):

                    if (

                        f.endswith(".err")

                        or

                        f.endswith(".log")

                    ):

                        mysql_error_path = os.path.join(

                            data_dir,

                            f

                        )

                        break


    # =================================================
    # FILE VALIDATION
    # =================================================

    if (

        not mysql_error_path

        or

        not os.path.exists(mysql_error_path)

    ):

        # Try performance_schema.events_errors_summary as a last-resort fallback
        # This works even on older MySQL and doesn't need file access
        try:

            fb_engine = create_engine(mysql_url, connect_args={"connect_timeout": 4})

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
                        "logged":     str(d.get("LAST_SEEN") or ""),
                        "severity":   "ERROR",
                        "subsystem":  "MySQL",
                        "error_code": str(d.get("ERROR_NUMBER", "")),
                        "message":    f"[{d.get('ERROR_NAME','')}] raised {d.get('count',0)} times (handled: {d.get('handled',0)}) — last seen: {d.get('LAST_SEEN','')}",
                        "status":     "OPEN",
                        "category":   "ERROR",
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
                "If MySQL is remote, the log file cannot be read from the backend server. "
                "Requires MySQL 8.0.22+ for performance_schema.error_log SQL access. "
                f"Log path reported by MySQL: {mysql_error_path or 'unknown'}"
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

