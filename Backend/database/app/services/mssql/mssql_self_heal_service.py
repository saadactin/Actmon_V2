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
import json
import logging
import os
import re
import time
import datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from urllib.parse import quote_plus

from app.models.connection_model import ConnectionMaster

logger = logging.getLogger("mssql_self_heal")


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
                           else "HIGH" if en in (18456, 701, 4060, 17806)
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


# ── error 17806 (SSPI/Kerberos handshake failure) — dedicated deep diagnostic ──
# Read-only by construction: every command below is a query/read verb (setspn -L/-X,
# Resolve-DnsName, Test-NetConnection, w32tm /query, Get-CimInstance, nltest, klist).
# There is no execution path for a "fix" here — run_command()'s pipeline is SQL-only
# and could not run a PowerShell string even if asked to; any remediation surfaced
# below is advisory text, never auto-executed (matches the existing 18456 state-13
# precedent: an OS-level instruction returned as text, not run).
#
# This is intentionally NOT wired into error_analysis()/`_remediation_for()` — those
# stay fast and unchanged for every error number (including 17806's existing KB
# entry + generic diagnostics). This is a separate, user-triggered endpoint so a
# routine error-log view never pays for a live SQL round-trip + an agent job.

_SSPI_ENABLED_ENV = "MSSQL_SSPI_DIAGNOSTICS_ENABLED"
_SSPI_SECTION_RE = re.compile(r"===SECTION::(\w+)===\s*")
_SSPI_OS_KEYS = ("spn", "dns_forward", "dns_reverse", "sql_port",
                 "kerberos_port", "rpc_port", "time_sync", "domain_context")


def _split_ps_sections(output: str) -> dict:
    """Split a composite PowerShell script's stdout back into named sections, keyed
    by marker name — a PowerShell-flavored analog of pg_diagnose_service.py's own
    marker-based `_split_sections()`. A section missing from the output (script
    error before reaching it, output truncated) simply isn't in the returned dict."""
    parts = _SSPI_SECTION_RE.split(output or "")
    sections = {}
    for i in range(1, len(parts) - 1, 2):
        sections[parts[i]] = parts[i + 1].strip()
    return sections


def _build_sspi_script(sql_host: str, sql_port: int, service_account: str) -> str:
    """One composite, read-only PowerShell script covering every OS-level SSPI/
    Kerberos check — a single agent round-trip instead of eight, mirroring
    pg_diagnose_service.py's 'one script, many marked sections' pattern. Every
    section is independently try/caught so one failing (or slow) cmdlet can't take
    the rest of the report down with it — only the OUTER agent timeout is shared."""
    host_lit = (sql_host or "").replace('"', '`"')
    acct_lit = (service_account or "").replace('"', '`"')
    port_val = int(sql_port or 1433)
    return f"""
$ErrorActionPreference = 'Continue'
$sqlHost = "{host_lit}"
$sqlPort = {port_val}
$svcAccount = "{acct_lit}"

Write-Output "===SECTION::SPN==="
try {{
    if ($svcAccount -and $svcAccount -ne "") {{
        $spnList = (setspn -L $svcAccount 2>&1 | Out-String)
    }} else {{
        $spnList = "SPN check: Unable to determine service account automatically"
    }}
    $dupScan = (setspn -X 2>&1 | Out-String)
    @{{ service_account = $svcAccount; spn_list = $spnList; duplicate_scan = $dupScan }} | ConvertTo-Json -Compress
}} catch {{ @{{ error = "$_" }} | ConvertTo-Json -Compress }}

Write-Output "===SECTION::DNS_FORWARD==="
try {{
    $fwd = Resolve-DnsName -Name $sqlHost -ErrorAction Stop | Select-Object Name,IPAddress,Type
    $fwd | ConvertTo-Json -Compress
}} catch {{ @{{ error = "$_" }} | ConvertTo-Json -Compress }}

Write-Output "===SECTION::DNS_REVERSE==="
try {{
    $ip = (Resolve-DnsName -Name $sqlHost -ErrorAction Stop | Where-Object {{ $_.IPAddress }} | Select-Object -First 1 -ExpandProperty IPAddress)
    if ($ip) {{
        $rev = Resolve-DnsName -Name $ip -Type PTR -ErrorAction Stop | Select-Object Name,NameHost
        $rev | ConvertTo-Json -Compress
    }} else {{
        @{{ error = "no IP resolved from forward lookup" }} | ConvertTo-Json -Compress
    }}
}} catch {{ @{{ error = "$_" }} | ConvertTo-Json -Compress }}

Write-Output "===SECTION::SQL_PORT==="
try {{
    $t = Test-NetConnection -ComputerName $sqlHost -Port $sqlPort -WarningAction SilentlyContinue
    @{{ computer = $t.ComputerName; port = $t.RemotePort; succeeded = $t.TcpTestSucceeded }} | ConvertTo-Json -Compress
}} catch {{ @{{ error = "$_" }} | ConvertTo-Json -Compress }}

Write-Output "===SECTION::KERBEROS_PORT==="
try {{
    $cs2 = Get-CimInstance Win32_ComputerSystem
    if ($cs2.PartOfDomain) {{
        $t2 = Test-NetConnection -ComputerName $cs2.Domain -Port 88 -WarningAction SilentlyContinue
        @{{ target = $cs2.Domain; port = 88; succeeded = $t2.TcpTestSucceeded }} | ConvertTo-Json -Compress
    }} else {{
        @{{ error = "host is not domain-joined" }} | ConvertTo-Json -Compress
    }}
}} catch {{ @{{ error = "$_" }} | ConvertTo-Json -Compress }}

Write-Output "===SECTION::RPC_PORT==="
try {{
    $cs3 = Get-CimInstance Win32_ComputerSystem
    if ($cs3.PartOfDomain) {{
        $t3 = Test-NetConnection -ComputerName $cs3.Domain -Port 135 -WarningAction SilentlyContinue
        @{{ target = $cs3.Domain; port = 135; succeeded = $t3.TcpTestSucceeded; note = "dynamic RPC ports above 135 may also be required" }} | ConvertTo-Json -Compress
    }} else {{
        @{{ error = "host is not domain-joined" }} | ConvertTo-Json -Compress
    }}
}} catch {{ @{{ error = "$_" }} | ConvertTo-Json -Compress }}

Write-Output "===SECTION::TIME_SYNC==="
try {{
    $tstatus = (w32tm /query /status 2>&1 | Out-String)
    $tsource = (w32tm /query /source 2>&1 | Out-String)
    @{{ status = $tstatus; source = $tsource }} | ConvertTo-Json -Compress
}} catch {{ @{{ error = "$_" }} | ConvertTo-Json -Compress }}

Write-Output "===SECTION::DOMAIN_CONTEXT==="
try {{
    $cs4 = Get-CimInstance Win32_ComputerSystem
    $dc = ""
    if ($cs4.PartOfDomain) {{
        $dc = (nltest /dsgetdc:$($cs4.Domain) 2>&1 | Out-String)
    }}
    $tickets = (klist 2>&1 | Out-String)
    @{{ domain = $cs4.Domain; part_of_domain = $cs4.PartOfDomain; dsgetdc = $dc; klist = $tickets }} | ConvertTo-Json -Compress
}} catch {{ @{{ error = "$_" }} | ConvertTo-Json -Compress }}
"""


def _sspi_json(raw_section: str):
    """Parse one section's JSON body; returns None if the section is missing/blank,
    raises nothing on malformed JSON (caller treats that as UNKNOWN)."""
    if not raw_section:
        return None
    return json.loads(raw_section)


def _classify_spn(raw_section):
    try:
        data = _sspi_json(raw_section)
    except Exception:
        return {"status": "UNKNOWN", "evidence": f"unparseable output: {(raw_section or '')[:200]}"}
    if data is None:
        return {"status": "UNKNOWN", "evidence": "SPN check produced no output."}
    if "error" in data:
        return {"status": "UNKNOWN", "evidence": data["error"]}
    spn_list = data.get("spn_list") or ""
    dup_scan = data.get("duplicate_scan") or ""
    if "Unable to determine" in spn_list:
        return {"status": "WARNING", "detail": "Unable to determine service account automatically",
                "evidence": spn_list}
    m = re.search(r"(\d+)\s+group", dup_scan, re.IGNORECASE)
    if m and int(m.group(1)) > 0:
        return {"status": "CRITICAL", "detail": "Duplicate SPN detected", "evidence": dup_scan[:500]}
    if "No such SPN found" in spn_list or not spn_list.strip():
        return {"status": "WARNING", "detail": "No SPN registered for this service account",
                "evidence": spn_list[:500]}
    return {"status": "PASS", "detail": "SPN registered, no duplicates detected", "evidence": spn_list[:500]}


def _classify_dns(raw_section):
    try:
        data = _sspi_json(raw_section)
    except Exception:
        return {"status": "UNKNOWN", "evidence": f"unparseable output: {(raw_section or '')[:200]}"}
    if data is None:
        return {"status": "UNKNOWN", "evidence": "DNS check produced no output."}
    if isinstance(data, dict) and "error" in data:
        return {"status": "WARNING", "detail": "DNS lookup failed", "evidence": data["error"]}
    return {"status": "PASS", "detail": "resolved", "evidence": data}


def _classify_port(raw_section):
    try:
        data = _sspi_json(raw_section)
    except Exception:
        return {"status": "UNKNOWN", "evidence": f"unparseable output: {(raw_section or '')[:200]}"}
    if data is None:
        return {"status": "UNKNOWN", "evidence": "Port check produced no output."}
    if "error" in data:
        return {"status": "UNKNOWN", "evidence": data["error"]}
    if data.get("succeeded"):
        return {"status": "PASS", "detail": f"port {data.get('port')} reachable", "evidence": data}
    return {"status": "CRITICAL", "detail": f"port {data.get('port')} NOT reachable", "evidence": data}


def _classify_time_sync(raw_section):
    try:
        data = _sspi_json(raw_section)
    except Exception:
        return {"status": "UNKNOWN", "evidence": f"unparseable output: {(raw_section or '')[:200]}"}
    if data is None:
        return {"status": "UNKNOWN", "evidence": "Time-sync check produced no output."}
    if "error" in data:
        return {"status": "UNKNOWN", "evidence": data["error"]}
    status_text = data.get("status") or ""
    if re.search(r"NOT SYNCHRONIZED|error|not been started|access is denied", status_text, re.IGNORECASE):
        return {"status": "WARNING", "detail": "Time service not synchronized", "evidence": status_text[:500]}
    return {"status": "PASS", "detail": "time synchronized", "evidence": status_text[:500]}


def _classify_domain_context(raw_section):
    try:
        data = _sspi_json(raw_section)
    except Exception:
        return {"status": "UNKNOWN", "evidence": f"unparseable output: {(raw_section or '')[:200]}"}
    if data is None:
        return {"status": "UNKNOWN", "evidence": "Domain-context check produced no output."}
    if "error" in data:
        return {"status": "UNKNOWN", "evidence": data["error"]}
    if not data.get("part_of_domain"):
        return {"status": "WARNING",
                "detail": "Host is not domain-joined — Kerberos is not possible from this host",
                "evidence": data}
    return {"status": "INFO", "detail": f"domain: {data.get('domain')}", "evidence": data}


_SSPI_CHECK_ORDER = ("sql_port", "spn", "auth_scheme", "time_sync", "kerberos_port",
                     "rpc_port", "dns_forward", "dns_reverse", "domain_context")
_SSPI_SEVERITY_RANK = {"CRITICAL": 3, "WARNING": 2, "UNKNOWN": 1, "INFO": 0, "PASS": 0}


def _sspi_root_cause(checks: dict) -> dict:
    """Pure, deterministic root-cause rules over the normalized check statuses —
    no agent/DB access, so this is trivially unit-testable in isolation. Never
    forces a single-cause guess when the evidence is genuinely mixed (spec case 5)."""
    findings = []
    for name in _SSPI_CHECK_ORDER:
        c = checks.get(name) or {}
        status = c.get("status", "UNKNOWN")
        if status in ("CRITICAL", "WARNING"):
            findings.append({"check": name, "status": status, "detail": c.get("detail", "")})
    findings.sort(key=lambda f: _SSPI_SEVERITY_RANK.get(f["status"], 0), reverse=True)

    if not findings:
        return {
            "likely_cause": "No obvious SSPI/Kerberos misconfiguration detected in these checks.",
            "recommended_action": "The failure may be transient or client-specific — review the SQL "
                                   "Server error log around the failure time and the client's own "
                                   "event log for more detail.",
            "confidence": "low", "findings": [],
        }

    if len(findings) > 1:
        return {
            "likely_cause": "Multiple potential causes detected.",
            "recommended_action": "Review each finding below, starting with the highest severity — "
                                   "do not assume a single root cause when several checks failed.",
            "confidence": "medium", "findings": findings,
        }

    only = findings[0]
    if only["check"] == "sql_port":
        cause = "Network/firewall/connectivity issue may be preventing the authentication handshake."
        action = "Confirm the SQL Server port is open between the client and this host (firewall, NSG, routing)."
    elif only["check"] == "spn":
        cause = ("Possible duplicate/misconfigured SPN causing Kerberos authentication failure."
                  if only["status"] == "CRITICAL" else "Likely Kerberos/SPN configuration issue.")
        action = ("Review the duplicate SPN and SQL Server service account configuration before "
                  "modifying the SPN." if only["status"] == "CRITICAL" else
                  "Review the SPN registration for the SQL Server service account.")
    elif only["check"] == "time_sync":
        cause = "Clock synchronization may be contributing to Kerberos authentication failure."
        action = ("Kerberos tickets are time-sensitive — verify the client, this host and the domain "
                  "controller are all within the domain's allowed clock skew (default 5 minutes).")
    elif only["check"] in ("kerberos_port", "rpc_port"):
        port = 88 if only["check"] == "kerberos_port" else 135
        cause = "Domain controller connectivity issue may be preventing Kerberos ticket issuance."
        action = f"Confirm port {port} is reachable from this host to its domain controller."
    elif only["check"] == "auth_scheme":
        cause = ("Diagnostic connection negotiated NTLM instead of Kerberos — evidence of a "
                  "Kerberos/SPN issue, not conclusive on its own.")
        action = "Cross-check against the SPN and DNS findings above before concluding Kerberos is misconfigured."
    else:
        cause = f"{only['check']} check reported {only['status']}: {only['detail']}"
        action = "Review this finding directly."

    return {"likely_cause": cause, "recommended_action": action,
            "confidence": "high" if only["status"] == "CRITICAL" else "medium",
            "findings": findings}


def run_sspi_diagnostics(connection_id: int, db: Session):
    """Dedicated, read-only deep diagnostic workflow for SQL Server error 17806
    (SSPI/Kerberos handshake failure). User-triggered (not part of error_analysis()'s
    fast path) so a routine error-log view never pays for this endpoint's SQL +
    agent round-trips. Gated by MSSQL_SSPI_DIAGNOSTICS_ENABLED for an instant,
    zero-code-change rollback if anything unexpected surfaces in production."""
    if os.environ.get(_SSPI_ENABLED_ENV, "true").strip().lower() == "false":
        return {"status": "disabled", "message": "SSPI deep diagnostics are disabled by configuration."}

    conn = _get_conn_or_404(connection_id, db)
    checks: dict = {}

    # ── SQL-side evidence — same _engine()/_rows() helpers as every other branch ──
    service_account = None
    try:
        engine = _engine(conn)
        rows = _rows(engine, "SELECT session_id, client_net_address, auth_scheme "
                              "FROM sys.dm_exec_connections WHERE session_id = @@SPID;")
        scheme = ((rows[0].get("auth_scheme") if rows else None) or "").strip()
        scheme_u = scheme.upper()
        if scheme_u == "KERBEROS":
            checks["auth_scheme"] = {"status": "PASS", "detail": scheme,
                                      "evidence": "Diagnostic connection negotiated Kerberos."}
        elif scheme_u == "NTLM":
            checks["auth_scheme"] = {"status": "WARNING", "detail": scheme,
                                      "evidence": "Diagnostic connection fell back to NTLM instead of "
                                                   "Kerberos — evidence, not proof, of a Kerberos/SPN issue."}
        elif scheme_u:
            checks["auth_scheme"] = {"status": "INFO", "detail": scheme,
                                      "evidence": "Non-Windows auth scheme — this check is only "
                                                   "meaningful for Windows authentication."}
        else:
            checks["auth_scheme"] = {"status": "UNKNOWN", "detail": None, "evidence": "auth_scheme not returned."}
    except Exception as e:
        checks["auth_scheme"] = {"status": "UNKNOWN", "detail": None, "evidence": f"query failed: {e}"}

    try:
        engine = _engine(conn)
        svc_rows = _rows(engine, "SELECT servicename, service_account FROM sys.dm_server_services "
                                  "WHERE servicename LIKE 'SQL Server (%';")
        info_rows = _rows(engine, "SELECT SERVERPROPERTY('ComputerNamePhysicalNetBIOS') AS computer_name, "
                                    "SERVERPROPERTY('ServerName') AS server_name, "
                                    "SERVERPROPERTY('InstanceName') AS instance_name;")
        if svc_rows:
            service_account = svc_rows[0].get("service_account")
        info = info_rows[0] if info_rows else {}
        checks["service_info"] = {
            "status": "INFO",
            "service_account": service_account,
            "computer_name": info.get("computer_name"),
            "server_name": info.get("server_name"),
            "instance_name": info.get("instance_name"),
        }
    except Exception as e:
        checks["service_info"] = {"status": "UNKNOWN", "evidence": f"query failed: {e}"}

    # ── OS-level evidence — one composite agent round-trip ──
    host = None
    try:
        from app.services.common import db_proxy_service
        host = db_proxy_service.agent_host_for_conn(connection_id, db)
    except Exception as e:
        logger.debug("SSPI diagnostics: agent_host_for_conn failed for connection %s: %s", connection_id, e)

    if not host or not getattr(host, "token", None):
        for key in _SSPI_OS_KEYS:
            checks[key] = {"status": "UNKNOWN",
                            "evidence": "No agent is linked to this SQL Server's host — OS-level checks unavailable."}
    else:
        try:
            from app.services.agent import agent_fs_service
            from app.services.common.diagnose_engine import _ps_encoded
            script = _build_sspi_script(conn.host, conn.port or 1433, service_account or "")
            started = time.time()
            raw = agent_fs_service.request(host.token, "shell", _ps_encoded(script), timeout=60)
            duration_ms = int((time.time() - started) * 1000)
            logger.info("SSPI diagnostics: connection=%s agent job duration_ms=%s status=%s",
                        connection_id, duration_ms, "no_response" if raw is None else "completed")
            if raw is None:
                for key in _SSPI_OS_KEYS:
                    checks[key] = {"status": "UNKNOWN", "evidence": "Agent did not respond within the timeout."}
            else:
                txt = raw.decode("utf-8", "replace")
                if txt.startswith("EXIT:"):
                    _, _, txt = txt.partition("\n")
                sections = _split_ps_sections(txt)
                checks["spn"] = _classify_spn(sections.get("SPN"))
                checks["dns_forward"] = _classify_dns(sections.get("DNS_FORWARD"))
                checks["dns_reverse"] = _classify_dns(sections.get("DNS_REVERSE"))
                checks["sql_port"] = _classify_port(sections.get("SQL_PORT"))
                checks["kerberos_port"] = _classify_port(sections.get("KERBEROS_PORT"))
                checks["rpc_port"] = _classify_port(sections.get("RPC_PORT"))
                checks["time_sync"] = _classify_time_sync(sections.get("TIME_SYNC"))
                checks["domain_context"] = _classify_domain_context(sections.get("DOMAIN_CONTEXT"))
        except Exception as e:
            logger.warning("SSPI diagnostics: agent dispatch failed for connection %s: %s", connection_id, e)
            for key in _SSPI_OS_KEYS:
                checks.setdefault(key, {"status": "UNKNOWN", "evidence": f"agent dispatch failed: {e}"})

    root_cause = _sspi_root_cause(checks)
    return {
        "status": "success",
        "error_number": 17806,
        "checks": checks,
        "root_cause": root_cause,
        "automatic_remediation": "NOT EXECUTED",
        "analyzed_at": datetime.datetime.now().isoformat(),
    }
