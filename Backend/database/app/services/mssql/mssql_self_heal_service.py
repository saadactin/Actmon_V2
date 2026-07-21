"""
MSSQL deep error analysis + permission-gated self-healing.

Given an error log line (e.g. "Error: 18456, Severity: 14, State: 5") this service:
  • decodes WHAT the error is and WHY it is happening (knowledge base + 18456 state decode)
  • checks whether the error is STILL occurring right now (re-reads the error log)
  • lists DIAGNOSTIC and REMEDIATION steps, each classified safe | caution | dangerous
  • reports what the connected login is actually ALLOWED to do (so the UI can gate self-heal)
  • runs a single command on demand and returns its output (the embedded "terminal")

Nothing is ever executed automatically — every remediation step is click-to-run, and any
write/DDL step is refused unless the connected login holds the required server role.
"""
import re
import time
import datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from urllib.parse import quote_plus

from app.models.connection_model import ConnectionMaster


# ── connection helpers ────────────────────────────────────────────────────────

def _get_conn_or_404(connection_id: int, db: Session) -> ConnectionMaster:
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mssql",
    ).first()
    if not conn:
        raise HTTPException(status_code=404, detail="MSSQL connection not found")
    return conn


def _engine(conn: ConnectionMaster, database: str = None):
    pw = quote_plus(conn.password or "")
    db_name = database or conn.database_name or "master"
    return create_engine(
        f"mssql+pyodbc://{conn.username}:{pw}@{conn.host}:{conn.port}/{db_name}"
        "?driver=ODBC+Driver+17+for+SQL+Server&timeout=8",
        pool_pre_ping=True,
    )


def _rows(engine, sql, params=None):
    with engine.connect() as c:
        r = c.execute(text(sql), params or {})
        if r.returns_rows:
            return [dict(row) for row in r.mappings().all()]
        return []


# ── 18456 (login failed) state decode ─────────────────────────────────────────
# State pinpoints the EXACT reason a login failed — the single most useful detail.
_STATE_18456 = {
    2:  ("Login not found", "The login (SQL user id) does not exist on this server.", "create_or_check_login"),
    5:  ("Login not found", "The login (SQL user id) does not exist on this server.", "create_or_check_login"),
    6:  ("Windows login used with SQL auth", "A Windows login name was supplied on a SQL-authentication attempt.", "check_auth_mode"),
    7:  ("Login disabled + wrong password", "The login is disabled AND the password is wrong.", "enable_login"),
    8:  ("Password mismatch", "The login exists but the password is incorrect.", "reset_password"),
    9:  ("Invalid password", "The password is not valid (format/expired).", "reset_password"),
    11: ("Valid login, no server access", "Login is valid but cannot access the server (often a Windows-group / permission issue).", "grant_connect"),
    12: ("Valid login, no server access", "Login is valid but server access failed (permission issue).", "grant_connect"),
    13: ("Server paused", "The SQL Server service is paused — no new connections accepted.", "resume_server"),
    18: ("Password change required", "The password is valid but must be changed before connecting.", "reset_password"),
    38: ("Cannot open database", "Login succeeded but the requested database could not be opened (missing, offline, or no access).", "check_database"),
    40: ("Cannot open database", "Login succeeded but the explicitly-named database could not be opened.", "check_database"),
    58: ("SQL auth on Windows-only server", "SQL-auth attempt while the server is in Windows-Authentication-only mode.", "check_auth_mode"),
}


# ── knowledge base for common SQL Server errors ────────────────────────────────
# Each entry: what / why / impact / severity_label, plus a remediation template key.
_ERROR_KB = {
    18456: {
        "title": "Login failed",
        "what": "SQL Server rejected a connection attempt (authentication failure).",
        "why": "A client tried to log in but the login/password/database/permission check failed. The exact reason is in the State number.",
        "impact": "Application or user cannot connect. Repeated failures can indicate a misconfiguration or a brute-force attempt.",
        "category": "authentication",
    },
    1205: {
        "title": "Deadlock victim",
        "what": "A transaction was chosen as a deadlock victim and rolled back.",
        "why": "Two or more sessions held locks the others needed, forming a cycle; SQL Server killed one to break it.",
        "impact": "The victim transaction failed and must be retried; concurrency/throughput suffers.",
        "category": "concurrency",
    },
    9002: {
        "title": "Transaction log full",
        "what": "The transaction log file for a database is full.",
        "why": "The log could not grow (autogrowth off/disk full) or is not being truncated (long transaction, FULL recovery without log backups).",
        "impact": "All writes to that database fail until log space is freed.",
        "category": "storage",
    },
    1105: {
        "title": "Filegroup full",
        "what": "Could not allocate space because a filegroup is full.",
        "why": "The data file cannot grow (autogrowth off or disk full).",
        "impact": "Inserts/updates that need new pages fail.",
        "category": "storage",
    },
    701: {
        "title": "Insufficient memory",
        "what": "There is insufficient system memory to run the query.",
        "why": "Memory pressure — workload exceeds available buffer pool / memory grants.",
        "impact": "Queries fail or are throttled.",
        "category": "memory",
    },
    823: {
        "title": "I/O error (823)",
        "what": "The OS reported an I/O error during a read/write to a database file.",
        "why": "Hardware/storage subsystem problem or file corruption.",
        "impact": "Possible data loss / corruption — urgent.",
        "category": "io",
    },
    824: {
        "title": "Logical consistency I/O error (824)",
        "what": "A logical consistency error was detected (e.g. torn page, bad checksum).",
        "why": "Storage corruption.",
        "impact": "Possible data corruption — urgent.",
        "category": "io",
    },
    4060: {
        "title": "Cannot open database",
        "what": "Cannot open the database requested by the login.",
        "why": "Database is offline, doesn't exist, or the login has no access.",
        "impact": "Connection to that database fails.",
        "category": "database",
    },
    17806: {
        "title": "SSPI handshake failed",
        "what": "A Windows-authentication (SSPI) handshake failed.",
        "why": "Kerberos/SPN misconfiguration, clock skew, or untrusted domain.",
        "impact": "Windows-auth connections fail.",
        "category": "authentication",
    },
}


def _parse_error(message: str, error_number=None, state=None):
    """Pull error number, state and the failing login from a raw error log line."""
    msg = message or ""
    en = error_number
    st = state
    login = None

    m = re.search(r"Error:\s*(\d+)", msg)
    if en in (None, "", 0) and m:
        en = int(m.group(1))
    m = re.search(r"State:\s*(\d+)", msg)
    if st in (None, "", 0) and m:
        st = int(m.group(1))
    m = re.search(r"for user\s*'([^']+)'", msg, re.IGNORECASE)
    if m:
        login = m.group(1)
    m2 = re.search(r"database\s*\"([^\"]+)\"", msg, re.IGNORECASE) or re.search(r"database\s*'([^']+)'", msg, re.IGNORECASE)
    database = m2.group(1) if m2 else None

    try:
        en = int(en) if en not in (None, "") else None
    except (ValueError, TypeError):
        en = None
    try:
        st = int(st) if st not in (None, "") else None
    except (ValueError, TypeError):
        st = None
    return en, st, login, database


# ── permissions: what can this login actually do? ─────────────────────────────

def heal_permissions(connection_id: int, db: Session):
    conn = _get_conn_or_404(connection_id, db)
    try:
        engine = _engine(conn)
        row = _rows(engine, """
            SELECT
                SUSER_SNAME()                               AS login_name,
                IS_SRVROLEMEMBER('sysadmin')                AS is_sysadmin,
                IS_SRVROLEMEMBER('securityadmin')           AS is_securityadmin,
                IS_SRVROLEMEMBER('serveradmin')             AS is_serveradmin,
                IS_SRVROLEMEMBER('processadmin')            AS is_processadmin,
                HAS_PERMS_BY_NAME(NULL, NULL, 'ALTER ANY LOGIN')      AS can_alter_login,
                HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE')    AS can_view_server_state
        """)
        p = row[0] if row else {}
        is_sysadmin = bool(p.get("is_sysadmin"))
        return {
            "status": "success",
            "login_name": p.get("login_name"),
            "is_sysadmin": is_sysadmin,
            "is_securityadmin": bool(p.get("is_securityadmin")),
            "is_serveradmin": bool(p.get("is_serveradmin")),
            "is_processadmin": bool(p.get("is_processadmin")),
            "can_alter_login": is_sysadmin or bool(p.get("can_alter_login")),
            "can_view_server_state": is_sysadmin or bool(p.get("can_view_server_state")),
            # self-heal (write/DDL) is only offered when the login can actually perform it
            "can_self_heal": is_sysadmin or bool(p.get("can_alter_login")) or bool(p.get("is_securityadmin")),
        }
    except Exception as e:
        return {"status": "error", "error": str(e), "can_self_heal": False}


# ── remediation step builders ──────────────────────────────────────────────────
# risk: safe (read-only diagnostics), caution (reversible config/state change),
#        dangerous (creates/alters logins, changes passwords, server state)

def _step(title, sql, risk, why, requires=None, database=None):
    return {
        "title": title, "sql": sql.strip(), "risk": risk, "why": why,
        "requires": requires or ([] if risk == "safe" else ["can_self_heal"]),
        "database": database,
    }


def _remediation_for(error_number, state, login, database, perms):
    """Return (diagnostics[], remediations[]) for the parsed error."""
    diagnostics, remediations = [], []
    lg = (login or "").replace("'", "''")
    dbn = (database or "").replace("'", "''")

    if error_number == 18456:
        diagnostics.append(_step(
            "Does this login exist?",
            f"SELECT name, type_desc, is_disabled, create_date, modify_date "
            f"FROM sys.server_principals WHERE name = '{lg}';" if login else
            "SELECT name, type_desc, is_disabled FROM sys.server_principals WHERE type IN ('S','U','G') ORDER BY name;",
            "safe", "Confirms whether the failing login is actually present on the server."))
        diagnostics.append(_step(
            "Recent failed logins (last hour)",
            "EXEC xp_readerrorlog 0, 1, N'Login failed', NULL, NULL, NULL, N'DESC';",
            "safe", "Shows how often and for which users logins are failing right now."))
        diagnostics.append(_step(
            "Server authentication mode",
            "SELECT CASE SERVERPROPERTY('IsIntegratedSecurityOnly') WHEN 1 THEN 'Windows only' "
            "ELSE 'SQL + Windows (mixed)' END AS auth_mode;",
            "safe", "State 7/58 usually means SQL auth is attempted on a Windows-only server."))

        if state in (2, 5):   # login not found
            if login:
                remediations.append(_step(
                    f"Create SQL login '{login}'",
                    f"CREATE LOGIN [{login}] WITH PASSWORD = N'<choose-a-strong-password>';",
                    "dangerous", "Creates the missing login. Replace the placeholder password before running."))
            remediations.append(_step(
                "List databases (was the right server targeted?)",
                "SELECT name, state_desc FROM sys.databases ORDER BY name;",
                "safe", "State 5 often means the client is pointed at the wrong instance."))
        elif state in (8, 9, 18):  # password
            if login:
                remediations.append(_step(
                    f"Reset password for '{login}'",
                    f"ALTER LOGIN [{login}] WITH PASSWORD = N'<new-strong-password>';",
                    "dangerous", "Sets a new password. Coordinate with the app/owner first."))
                remediations.append(_step(
                    f"Unlock '{login}' (if locked out)",
                    f"ALTER LOGIN [{login}] WITH PASSWORD = N'<new-strong-password>' UNLOCK;",
                    "dangerous", "Clears a lockout caused by the password policy."))
        elif state == 7:  # disabled + wrong password
            if login:
                remediations.append(_step(
                    f"Enable login '{login}'",
                    f"ALTER LOGIN [{login}] ENABLE;",
                    "caution", "Re-enables a disabled login (reversible with DISABLE)."))
        elif state in (11, 12):  # no server access
            if login:
                remediations.append(_step(
                    f"Grant CONNECT SQL to '{login}'",
                    f"GRANT CONNECT SQL TO [{login}];",
                    "caution", "Allows the valid login to connect to the engine."))
        elif state in (38, 40):  # cannot open database
            remediations.append(_step(
                "Check database state",
                f"SELECT name, state_desc, user_access_desc FROM sys.databases WHERE name = '{dbn}';" if database else
                "SELECT name, state_desc, user_access_desc FROM sys.databases ORDER BY name;",
                "safe", "Confirms the target database exists and is ONLINE."))
            if login and database:
                remediations.append(_step(
                    f"Grant '{login}' access to [{database}]",
                    f"USE [{database}]; CREATE USER [{login}] FOR LOGIN [{login}];",
                    "dangerous", "Maps the server login to a database user.", database=database))
        elif state == 13:  # paused
            remediations.append(_step(
                "Resume the server (from OS)",
                "-- Run on the host:  net continue MSSQLSERVER\n-- (or the named-instance service)",
                "dangerous", "The service is paused; resume it to accept connections."))

    elif error_number == 9002:   # log full
        diagnostics.append(_step(
            "Log space per database",
            "DBCC SQLPERF(LOGSPACE);",
            "safe", "Shows how full each transaction log is."))
        diagnostics.append(_step(
            "Why isn't the log truncating?",
            "SELECT name, log_reuse_wait_desc, recovery_model_desc FROM sys.databases ORDER BY name;",
            "safe", "log_reuse_wait_desc tells you exactly what is pinning the log."))
        if database:
            remediations.append(_step(
                f"Back up the log of [{database}] (frees space, FULL recovery)",
                f"BACKUP LOG [{database}] TO DISK = N'<path>\\{dbn}_log.trn';",
                "caution", "A log backup truncates the log without data loss (FULL recovery model)."))
            remediations.append(_step(
                f"Allow the log file to autogrow on [{database}]",
                f"-- Inspect first, then set a sane growth/maxsize:\n"
                f"SELECT name, growth, max_size FROM sys.master_files WHERE type_desc='LOG' "
                f"AND database_id = DB_ID('{dbn}');",
                "safe", "Confirm the log can grow; adjust growth/maxsize if it is capped."))

    elif error_number in (1105,):  # filegroup full
        diagnostics.append(_step(
            "Free space per data file",
            "SELECT DB_NAME(database_id) AS db, name, type_desc, "
            "size*8/1024 AS size_mb, max_size FROM sys.master_files ORDER BY size DESC;",
            "safe", "Find the full file and whether it can grow."))

    elif error_number in (823, 824):  # IO / corruption
        diagnostics.append(_step(
            "Recent suspect pages",
            "SELECT * FROM msdb.dbo.suspect_pages ORDER BY last_update_date DESC;",
            "safe", "Lists pages flagged with I/O / checksum errors."))
        if database:
            diagnostics.append(_step(
                f"Integrity check on [{database}]",
                f"DBCC CHECKDB ('{dbn}') WITH NO_INFOMSGS, ALL_ERRORMSGS;",
                "caution", "Verifies database integrity (can be I/O heavy — run off-peak).", database=database))

    elif error_number == 1205:   # deadlock
        diagnostics.append(_step(
            "Capture recent deadlocks (system_health)",
            "SELECT CAST(target_data AS XML) AS deadlock_xml "
            "FROM sys.dm_xe_session_targets st "
            "JOIN sys.dm_xe_sessions s ON s.address = st.event_session_address "
            "WHERE s.name = 'system_health' AND st.target_name = 'ring_buffer';",
            "safe", "The system_health session already records deadlock graphs."))

    elif error_number == 4060:   # cannot open db
        diagnostics.append(_step(
            "Database states",
            "SELECT name, state_desc, user_access_desc FROM sys.databases ORDER BY name;",
            "safe", "Find offline/restoring/missing databases."))

    # universal safe diagnostics
    diagnostics.append(_step(
        "Server health snapshot",
        "SELECT (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process=1) AS user_sessions, "
        "(SELECT COUNT(*) FROM sys.dm_exec_requests WHERE blocking_session_id<>0) AS blocked_requests;",
        "safe", "Quick look at current sessions and blocking."))
    return diagnostics, remediations


# ── deep analysis endpoint ──────────────────────────────────────────────────────

def error_analysis(connection_id: int, payload: dict, db: Session):
    conn = _get_conn_or_404(connection_id, db)
    message = payload.get("message") or payload.get("error_message") or ""
    en, st, login, database = _parse_error(message, payload.get("error_number"), payload.get("state"))

    kb = _ERROR_KB.get(en, {})
    state_label = state_why = None
    if en == 18456 and st in _STATE_18456:
        state_label, state_why, _ = _STATE_18456[st]

    perms = heal_permissions(connection_id, db)

    # Is it STILL happening? Re-read the log for the same error in the recent past.
    still_occurring = None
    recent_hits = []
    occurrences = 0
    try:
        engine = _engine(conn)
        search = f"Error: {en}" if en else "Error:"
        rows = _rows(engine, f"EXEC xp_readerrorlog 0, 1, N'{search}', NULL, NULL, NULL, N'DESC';")
        now = datetime.datetime.now()
        for r in rows[:50]:
            txt = str(r.get("Text") or r.get("text") or "")
            when = str(r.get("LogDate") or r.get("logdate") or "")
            recent_hits.append({"logged": when, "message": txt})
        occurrences = len(rows)
        # consider it "still occurring" if the newest hit is within the last 15 minutes
        if rows:
            try:
                newest = rows[0].get("LogDate") or rows[0].get("logdate")
                if isinstance(newest, datetime.datetime):
                    still_occurring = (now - newest).total_seconds() < 900
            except Exception:
                still_occurring = None
    except Exception:
        pass

    diagnostics, remediations = _remediation_for(en, st, login, database, perms)

    # plain-English summary
    what = kb.get("what") or f"SQL Server reported error {en}." if en else "SQL Server error."
    why = state_why or kb.get("why") or "See diagnostics below to pinpoint the cause."

    return {
        "status": "success",
        "error_number": en,
        "state": st,
        "login": login,
        "database": database,
        "title": (f"{kb.get('title','Error')}"
                  + (f" — {state_label}" if state_label else "")),
        "what": what,
        "why": why,
        "impact": kb.get("impact"),
        "category": kb.get("category"),
        "severity_label": ("CRITICAL" if en in (823, 824, 9002, 1105)
                           else "HIGH" if en in (18456, 701, 4060)
                           else "MEDIUM"),
        "is_still_occurring": still_occurring,
        "occurrences": occurrences,
        "recent_hits": recent_hits[:15],
        "permissions": perms,
        "diagnostics": diagnostics,
        "remediations": remediations,
        "exec_plan_relevant": en in (1205, 701, 1053),
        "backup_relevant": en in (9002, 1105, 823, 824),
        "analyzed_at": datetime.datetime.now().isoformat(),
    }


# ── the embedded "terminal": run one command on demand ─────────────────────────

_READ_ONLY_RE = re.compile(
    r"^\s*(SELECT|WITH|DBCC\s+SQLPERF|DBCC\s+CHECKDB|EXEC\s+xp_readerrorlog|EXEC\s+sp_who|"
    r"EXEC\s+sp_helpdb|SET\s+|USE\s+|PRINT\s+|--)",
    re.IGNORECASE)


def _is_read_only(sql: str) -> bool:
    body = "\n".join(l for l in (sql or "").splitlines() if not l.strip().startswith("--")).strip()
    if not body:
        return True
    # any write/DDL verb makes it non-read-only
    if re.search(r"\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT|REVOKE|DENY|BACKUP|RESTORE|KILL|TRUNCATE|MERGE|EXEC\s+sp_configure)\b",
                 body, re.IGNORECASE):
        return False
    return bool(_READ_ONLY_RE.match(body))


def run_command(connection_id: int, payload: dict, db: Session):
    conn = _get_conn_or_404(connection_id, db)
    sql = (payload.get("sql") or "").strip()
    if not sql:
        raise HTTPException(status_code=400, detail="No SQL provided")
    if "<" in sql and ">" in sql:
        return {"status": "error", "command": sql,
                "error": "This command still contains a <placeholder>. Fill it in before running.",
                "read_only": _is_read_only(sql)}

    read_only = _is_read_only(sql)

    # gate write/DDL behind real server permission
    if not read_only:
        perms = heal_permissions(connection_id, db)
        if not perms.get("can_self_heal"):
            return {"status": "denied", "command": sql, "read_only": False,
                    "error": (f"Self-heal blocked: the login '{perms.get('login_name')}' is not a sysadmin/"
                              "securityadmin and lacks ALTER ANY LOGIN, so it cannot run write/DDL commands.")}

    started = time.time()
    try:
        engine = _engine(conn, database=payload.get("database"))
        # AUTOCOMMIT + raw driver SQL: admin/heal commands like BACKUP, DBCC, ALTER DATABASE,
        # RESTORE and KILL CANNOT run inside an explicit transaction, and the raw driver call
        # avoids SQLAlchemy treating ":word" / "N'..:..'" patterns as bind parameters.
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as c:
            result = c.exec_driver_sql(sql)
            rows, columns, rowcount = [], [], None
            try:
                returns_rows = result.returns_rows
            except Exception:
                returns_rows = False
            if returns_rows:
                mapped = result.mappings().all()
                rows = [dict(r) for r in mapped][:200]
                columns = list(rows[0].keys()) if rows else list(result.keys())
                for r in rows:
                    for k, v in r.items():
                        if isinstance(v, (datetime.datetime, datetime.date)):
                            r[k] = str(v)
                        elif hasattr(v, "__class__") and v.__class__.__name__ == "Decimal":
                            r[k] = float(v)
            else:
                rowcount = result.rowcount
        dur = int((time.time() - started) * 1000)
        return {
            "status": "success", "command": sql, "read_only": read_only,
            "columns": columns, "rows": rows, "rowcount": rowcount,
            "row_returned": len(rows), "duration_ms": dur,
            "message": (f"{len(rows)} row(s) returned" if rows
                        else f"Command completed ({rowcount if rowcount not in (None, -1) else 0} row(s) affected)."),
        }
    except Exception as e:
        # surface the clean SQL Server message (strip the pyodbc/driver wrapper noise)
        raw = str(e)
        m = re.search(r"\](?:\[SQL Server\])?\s*(.+?)(?:\s*\(\d+\))?\s*(?:\[SQL|\(Background|$)", raw)
        clean = m.group(1).strip() if m else raw
        return {"status": "error", "command": sql, "read_only": read_only,
                "duration_ms": int((time.time() - started) * 1000),
                "error": clean[:500], "error_full": raw[:1000]}
