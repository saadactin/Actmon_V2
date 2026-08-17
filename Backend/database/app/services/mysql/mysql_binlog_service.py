"""
MySQL/MariaDB Binary Log status, file listing, and event inspection —
backs the dedicated "Binary Logs" dashboard page.

Deliberately its own module, not folded into `mysql_replication_service.py`
(which already reads `SHOW MASTER STATUS`/`SHOW BINARY LOG STATUS` for
replication purposes) — this one is scoped to binlog file MANAGEMENT
(status, the file list, and one file's events), never mixes in error-log or
slow-query content, and is read-only throughout: nothing here ever creates,
purges, or rotates a binary log. Never uses performance_schema — everything
here is native `SHOW BINARY LOGS`/`SHOW MASTER STATUS`/`SHOW BINLOG EVENTS`
and `SHOW GLOBAL VARIABLES`.

Every listing here is server-side paginated. `SHOW BINLOG EVENTS` in
particular natively supports `LIMIT [offset,] row_count`, so a multi-GB
binlog file is never read into memory at once — only the requested page's
rows ever leave MySQL.

Connection handling: `_engine_for()`'s engine is built with `NullPool`, so
every `.connect()` opens a brand-new physical connection (its own TCP +
MySQL auth handshake) rather than reusing a pooled one. Each function here
therefore opens exactly ONE connection and runs every query it needs on
that same connection — the earlier version called a `_rows()` helper that
opened its own connection per query, so `get_binlog_status()` alone was
opening 4-5 separate connections sequentially, which is what made the page
hang on "Reading binary log configuration…" over any connection with real
network latency.
"""
import re
from urllib.parse import quote_plus

from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.models.connection_model import ConnectionMaster
from app.services.common import db_proxy_service


def _engine_for(conn: ConnectionMaster):
    pw = quote_plus(conn.password or "")
    usr = quote_plus(conn.username or "")
    url = f"mysql+pymysql://{usr}:{pw}@{conn.host}:{conn.port or 3306}/{conn.database_name or ''}"
    return db_proxy_service.engine_for(
        conn, lambda: create_engine(url, connect_args={"connect_timeout": 10}, poolclass=NullPool)
    )


def _rows_on(conn, sql: str) -> list:
    """Run one statement on an ALREADY-OPEN connection — never opens its own."""
    res = conn.execute(text(sql))
    cols = list(res.keys())
    return [dict(zip(cols, row)) for row in res.fetchall()]


def _variables_on(conn, names: list) -> dict:
    """All requested `SHOW GLOBAL VARIABLES` in ONE round trip, on the given
    open connection — the previous version ran one `LIKE` query per variable
    (7 separate connections+queries just for the status cards)."""
    in_list = ",".join(f"'{n}'" for n in names)
    try:
        rows = _rows_on(conn, f"SHOW GLOBAL VARIABLES WHERE Variable_name IN ({in_list})")
        return {r["Variable_name"]: r["Value"] for r in rows}
    except Exception:
        return {}


def _current_file_status_on(conn) -> dict:
    """`SHOW MASTER STATUS` works on every MySQL/MariaDB version currently
    in real-world use; it was renamed `SHOW BINARY LOG STATUS` only in MySQL
    8.4+. Trying the near-universal name FIRST (rather than the other way
    around) means the common case succeeds on the first attempt instead of
    always eating one guaranteed-to-fail round trip before falling back."""
    for stmt in ("SHOW MASTER STATUS", "SHOW BINARY LOG STATUS"):
        try:
            rows = _rows_on(conn, stmt)
            if rows:
                r = rows[0]
                return {"file": r.get("File"), "position": r.get("Position")}
        except Exception:
            continue
    return {"file": None, "position": None}


def _connection(conn_id: int, db: Session) -> ConnectionMaster:
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        raise HTTPException(404, "Connection not found")
    return rec


def get_binlog_status(conn_id: int, db: Session) -> dict:
    """Configuration + at-a-glance counters — everything the page's status
    cards need, in ONE MySQL connection (3 queries: variables, file list,
    current-file-status) rather than the 4-5 separate connections this used
    to open."""
    rec = _connection(conn_id, db)
    engine = _engine_for(rec)

    try:
        with engine.connect() as conn:
            v = _variables_on(conn, [
                "log_bin", "binlog_format", "server_id", "expire_logs_days",
                "binlog_expire_logs_seconds", "sync_binlog", "max_binlog_size",
            ])
            enabled = str(v.get("log_bin", "OFF")).upper() in ("ON", "1")

            files, total_size = [], 0
            try:
                files = _rows_on(conn, "SHOW BINARY LOGS")
                total_size = sum(int(f.get("File_size") or 0) for f in files)
            except Exception:
                pass

            current = _current_file_status_on(conn) if enabled else {"file": None, "position": None}
    except Exception as e:
        return {"status": "error", "error": str(e)}

    # Retention: 8.0+ exposes binlog_expire_logs_seconds (0 = disabled unless
    # expire_logs_days also set); older servers only have expire_logs_days.
    expire_days = v.get("expire_logs_days")
    expire_seconds = v.get("binlog_expire_logs_seconds")
    if expire_days and int(expire_days) > 0:
        retention = f"{expire_days} day(s)"
    elif expire_seconds and int(expire_seconds) > 0:
        days = int(expire_seconds) / 86400
        retention = f"{days:.1f} day(s)" if days % 1 else f"{int(days)} day(s)"
    else:
        retention = "No automatic expiration configured"

    return {
        "status": "success",
        "enabled": enabled,
        "format": v.get("binlog_format"),
        "server_id": v.get("server_id"),
        "sync_binlog": v.get("sync_binlog"),
        "max_binlog_size": v.get("max_binlog_size"),
        "retention": retention,
        "current_file": current.get("file"),
        "current_position": current.get("position"),
        "file_count": len(files),
        "total_size_bytes": total_size,
    }


def list_binlog_files(
    conn_id: int, db: Session,
    search: str = None, sort_by: str = "name", sort_dir: str = "desc",
    page: int = 1, page_size: int = 25,
) -> dict:
    """`SHOW BINARY LOGS` returns every file's name/size in one cheap call —
    filtering/sorting/pagination all happen here, in Python, over that small
    list (file names + sizes only; never file CONTENTS, and never
    performance_schema). `total`/`has_next`/`has_previous` are all derived
    from THIS SAME fetch, in this same request, so they can never disagree
    with what `files` actually contains — no separate/stale count."""
    rec = _connection(conn_id, db)
    engine = _engine_for(rec)

    try:
        with engine.connect() as conn:
            # When binary logging is OFF, `SHOW BINARY LOGS` doesn't return
            # an empty result — it raises a MySQL error ("You are not using
            # binary logging"). Checking the variable first means that's a
            # clean, expected "no files" response instead of a surfaced 500.
            v = _variables_on(conn, ["log_bin"])
            if str(v.get("log_bin", "OFF")).upper() not in ("ON", "1"):
                return {
                    "status": "success", "files": [], "total": 0,
                    "page": 1, "page_size": max(1, min(page_size, 200)),
                    "has_next": False, "has_previous": False,
                    "current_file": None, "current_position": None,
                    "binlog_enabled": False,
                }
            raw = _rows_on(conn, "SHOW BINARY LOGS")
            current = _current_file_status_on(conn)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"MySQL error: {e}")

    current_file = current.get("file")

    rows = [
        {
            "log_name": r.get("Log_name"),
            "size_bytes": int(r.get("File_size") or 0),
            "encrypted": str(r.get("Encrypted") or "No").lower() in ("yes", "1"),
            "is_current": r.get("Log_name") == current_file,
            # Every binary log file begins with the same 4-byte magic
            # number, so its first real event always starts at position 4 —
            # a format constant, not a per-file value that needs its own
            # query. The previous version ran a `SHOW BINLOG EVENTS ... LIMIT 1`
            # PER FILE on every page just to re-derive this same constant —
            # a real N+1 (up to `page_size` extra connections+queries per
            # page load) removed here with no loss of real information.
            "first_position": 4,
        }
        for r in raw
    ]

    if search:
        q = search.strip().lower()
        rows = [r for r in rows if q in (r["log_name"] or "").lower()]

    reverse = (sort_dir != "asc")
    key_fn = {
        "name": lambda r: r["log_name"] or "",
        "size": lambda r: r["size_bytes"],
    }.get(sort_by, lambda r: r["log_name"] or "")
    rows.sort(key=key_fn, reverse=reverse)

    total = len(rows)
    page = max(1, page)
    page_size = max(1, min(page_size, 200))
    # If the requested page is beyond the actual last page (e.g. the file
    # count shrank between requests — a real rotation/purge on a live
    # server), clamp to the last real page rather than returning an empty
    # slice for a page number that no longer exists. The response's own
    # `page` always reflects what was ACTUALLY served, so the frontend never
    # has to guess whether a "page" it asked for was honored as-is.
    last_page = max(1, -(-total // page_size)) if total else 1
    if page > last_page:
        page = last_page
    start = (page - 1) * page_size
    page_rows = rows[start:start + page_size]

    return {
        "status": "success",
        "files": page_rows,
        "total": total,
        "page": page,
        "page_size": page_size,
        "has_next": (page * page_size) < total,
        "has_previous": page > 1,
        "current_file": current_file,
        "current_position": current.get("position"),
        "binlog_enabled": True,
    }


_LOG_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def _safe_log_name(log_name: str) -> str:
    """Binary log names are always plain filenames (`host-bin.000123`) —
    reject anything else outright rather than trying to escape it, since
    this value is inlined into `SHOW BINLOG EVENTS IN '<name>'` (a statement
    MySQL doesn't let you parametrize)."""
    if not log_name or not _LOG_NAME_RE.match(log_name):
        raise HTTPException(400, "Invalid binary log file name")
    return log_name


def get_binlog_events(
    conn_id: int, db: Session, log_name: str,
    page: int = 1, page_size: int = 100,
) -> dict:
    """One binlog file's events, paginated natively by MySQL itself via
    `SHOW BINLOG EVENTS IN '<file>' LIMIT [offset,] row_count` — no full-file
    read, ever. `log_name` is checked against the server's OWN current file
    list before use (never trusted as free-form input). Both queries run on
    ONE connection."""
    rec = _connection(conn_id, db)
    engine = _engine_for(rec)
    log_name = _safe_log_name(log_name)

    page = max(1, page)
    page_size = max(1, min(page_size, 500))
    offset = (page - 1) * page_size

    try:
        with engine.connect() as conn:
            real_names = {r.get("Log_name") for r in _rows_on(conn, "SHOW BINARY LOGS")}
            if log_name not in real_names:
                raise HTTPException(404, "Binary log file not found on this server")
            rows = _rows_on(conn, f"SHOW BINLOG EVENTS IN '{log_name}' LIMIT {offset}, {page_size}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"MySQL error: {e}")

    events = [
        {
            "position": r.get("Pos"),
            "end_position": r.get("End_log_pos"),
            "event_type": r.get("Event_type"),
            "server_id": r.get("Server_id"),
            "timestamp": r.get("Time") or None,
            "info": r.get("Info"),
        }
        for r in rows
    ]

    return {
        "status": "success",
        "log_name": log_name,
        "events": events,
        "page": page,
        "page_size": page_size,
        # MySQL gives no cheap COUNT(*) for this statement — signal whether
        # a next page is even worth requesting instead of pretending to
        # know an exact total (which would require reading the whole file).
        "has_more": len(events) == page_size,
    }
