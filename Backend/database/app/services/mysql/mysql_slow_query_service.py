import csv
import hashlib
import io
import json
import os
import re
from datetime import datetime, timedelta
from urllib.parse import quote_plus

import paramiko
from fastapi import HTTPException
from sqlalchemy import create_engine, text
from app.services.common import db_proxy_service
from sqlalchemy.pool import NullPool
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.services.common.slow_query_normalize import attach_normalized, build_normalized_row


# ── ActMon-internal query classification ──────────────────────────────────────
#
# `performance_schema.events_statements_summary_by_digest` (and the raw slow
# query log) record EVERY statement the server sees, from EVERY connection —
# including ActMon's own. ActMon polls the server it's monitoring every few
# seconds for dashboard data (SHOW GLOBAL STATUS/VARIABLES, information_schema
# introspection, table previews, …), and because those digests accumulate the
# same way a real query would, they used to crowd out — or outright dominate —
# the "Slow Queries" list with ActMon's own housekeeping instead of the
# monitored application's actual workload.
#
# Filtering by the CONNECTING USER is deliberately NOT used here: the same
# credential ActMon uses to monitor a database may be the exact same one an
# application uses to run its own queries (shared service accounts are
# common), so a user-based filter would silently swallow real slow queries
# too. Instead this classifies by WHAT the statement is and WHERE it points —
# signals that hold regardless of which connection/user issued it:
#
#   1. Target schema: no application's real workload optimizes queries
#      against `information_schema` / `performance_schema` / `mysql` / `sys`
#      — those are catalog/introspection views, not business data.
#   2. Statement shape: SHOW / EXPLAIN / DESCRIBE / ANALYZE TABLE /
#      OPTIMIZE TABLE / CHECK TABLE / FLUSH / KILL are administrative or
#      introspection commands, never "workload" a slow-query optimizer would
#      act on — regardless of which schema they're run against.
#   3. ActMon's own literal signature queries: the dashboard issues a small,
#      fixed set of fully-qualified `` `db`.`table` `` statements (table
#      preview / row count) that a real application essentially never writes
#      in that exact shape, since an app is already `USE`'d into its schema
#      and reads unqualified table names.
#
# Keeping this in one place (rather than scattered filters) means the rule
# set stays auditable and is easy to extend as ActMon's own query surface
# grows — see mysql_table_service.py / mysql_index_service.py for the
# concrete queries layer 3 matches.
ACTMON_SYSTEM_SCHEMAS = {"information_schema", "performance_schema", "mysql", "sys"}

# performance_schema's digest SCHEMA_NAME reflects the connection's DEFAULT
# schema at execution time — NOT which schema the statement's FROM clause
# actually reads. ActMon's own introspection connections often carry no
# default schema at all (SCHEMA_NAME comes back NULL → "(all)"), even though
# the query explicitly reads `information_schema` / `performance_schema` /
# `mysql` / `sys` in its FROM/JOIN. So the schema check must also look inside
# the statement text itself, not just trust SCHEMA_NAME.
_SYSTEM_SCHEMA_REF_RE = re.compile(
    r"`?\b(information_schema|performance_schema|mysql|sys)\b`?\s*\.", re.IGNORECASE
)

_ADMIN_VERB_RE = re.compile(
    r"^\s*(SHOW|EXPLAIN|DESC|DESCRIBE|ANALYZE\s+TABLE|OPTIMIZE\s+TABLE|CHECK\s+TABLE|FLUSH|KILL"
    r"|COMMIT|ROLLBACK|USE)\b",
    re.IGNORECASE,
)

# `SELECT @@var` (session/global system-variable reads — @@version,
# @@sql_mode, @@transaction_isolation, @@datadir, …) and `SELECT SLEEP(...)`
# are connection bootstrap/health-check noise, never business queries — a
# real application's own SELECT never starts with either shape.
_SELECT_SYSVAR_RE = re.compile(r"^\s*SELECT\s+@@", re.IGNORECASE)
_SELECT_SLEEP_RE = re.compile(r"^\s*SELECT\s+SLEEP\s*\(", re.IGNORECASE)

# A bare `SET <system_var> = ...` (session/global config — autocommit,
# sql_mode, long_query_time, character set, time zone, …) is connection
# setup, never application workload. This deliberately does NOT match
# `SET @user_var := ...` (no `@` in the identifier class below) — a real
# application's own procedural use of a user variable stays visible.
_SESSION_SET_RE = re.compile(
    r"^\s*SET\s+(?:SESSION\s+|GLOBAL\s+|@@session\.|@@global\.)?"
    r"(?:NAMES\b|CHARACTER\s+SET\b|[A-Za-z_][A-Za-z0-9_]*\s*:?=)",
    re.IGNORECASE,
)

# `db`.`table` (backtick-qualified two-part name) is the tell — ActMon always
# qualifies this way because it targets a caller-specified database; an
# application already connected to its own schema virtually never does.
_QUALIFIED_TABLE = r"`?[A-Za-z0-9_$]+`?\s*\.\s*`?[A-Za-z0-9_$]+`?"
_ACTMON_SIGNATURE_RES = [
    re.compile(rf"^\s*SELECT\s+\*\s+FROM\s+{_QUALIFIED_TABLE}\s+LIMIT\b", re.IGNORECASE),
    re.compile(rf"^\s*SELECT\s+COUNT\s*\(\s*\*\s*\)\s+FROM\s+{_QUALIFIED_TABLE}\s*$", re.IGNORECASE),
]

_USER_HOST_RE = re.compile(
    r"User@Host:\s*([^\[\s]+)\[[^\]]*\]\s*@\s*([^\[]*)\[([^\]]*)\]", re.IGNORECASE
)

# Every mysqld startup writes this 3-line banner straight into the slow log
# file (not just at the very top — on every restart, wherever it happens to
# fall in the file). It has no leading "#", so a query logged right before a
# restart has this banner text run straight into its own captured SQL unless
# explicitly cut off here.
_MYSQLD_BANNER_RE = re.compile(r"[A-Za-z]:\\[^\n]*mysqld(?:\.exe)?,\s*Version:", re.IGNORECASE)

# mysqld logs a client disconnect (Quit/Sleep/Ping) as its own slow-log entry
# when the connection's teardown crosses long_query_time — this is a
# connection-lifecycle event, not a query. Its own "#"-prefixed marker line
# isn't preceded by "\n" from the capture regex's anchor point (it directly
# follows "SET timestamp=...;\n" with nothing in between), so it gets pulled
# into sql_text the same way the mysqld banner does; cut at its first
# occurrence too so an entry that's ONLY this marker reduces to an empty
# sql_text and is dropped by the `if not sql_text` check below.
_ADMIN_COMMAND_RE = re.compile(r"#\s*administrator command:", re.IGNORECASE)


def is_actmon_internal_query(db_name: str, sql_text: str) -> bool:
    """True if this statement is MySQL/MariaDB system-schema traffic, a
    session/connection-setup command, or ActMon's own monitoring/introspection
    traffic — never the monitored database's real application workload. See
    the module docstring above for the classification rules."""
    if (db_name or "").strip().lower() in ACTMON_SYSTEM_SCHEMAS:
        return True
    text_ = (sql_text or "").strip()
    if not text_:
        return False
    if _SYSTEM_SCHEMA_REF_RE.search(text_):
        return True
    if _ADMIN_VERB_RE.match(text_):
        return True
    if _SESSION_SET_RE.match(text_):
        return True
    if _SELECT_SYSVAR_RE.match(text_) or _SELECT_SLEEP_RE.match(text_):
        return True
    return any(p.match(text_) for p in _ACTMON_SIGNATURE_RES)


def _split_internal(queries: list) -> tuple:
    """Partition a query list into (application_workload, actmon_internal)."""
    app_q, internal_q = [], []
    for q in queries:
        (internal_q if is_actmon_internal_query(q.get("db_name"), q.get("sql_text")) else app_q).append(q)
    return app_q, internal_q


# ── Private helpers ───────────────────────────────────────────────────────────

def _mysql_url(conn: ConnectionMaster) -> str:
    pw = quote_plus(conn.password or "")
    return f"mysql+pymysql://{conn.username}:{pw}@{conn.host}:{conn.port}/{conn.database_name or ''}"


def _read_file_via_ssh(host: str, port: int, username: str, password: str, filepath: str):
    """Cat a remote file over SSH. Returns (content_str, error_str)."""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=host,
            port=int(port or 22),
            username=username,
            password=password,
            timeout=10,
            look_for_keys=False,
            allow_agent=False,
        )
        _, stdout, stderr = client.exec_command(f"cat '{filepath}'", timeout=30)
        content = stdout.read().decode("utf-8", errors="ignore")
        err = stderr.read().decode("utf-8", errors="ignore").strip()
        if not content and err:
            return None, err
        return content, None
    except Exception as e:
        return None, str(e)
    finally:
        try:
            client.close()
        except Exception:
            pass


def _parse_slow_log_content(content: str, default_db: str) -> list:
    """Parse MySQL/MariaDB slow query log text into a list of query dicts.

    No filtering by SQL verb/pattern happens here — every recorded entry with
    a `Query_time:` header is a genuine logged statement (SELECT, INSERT,
    UPDATE, DELETE, REPLACE, DDL, anything) and is kept. The only exclusion
    applied anywhere in this module is ActMon-internal/system traffic, done
    later by `is_actmon_internal_query`/`_split_internal` — never a verb
    whitelist.

    `db_name` carries forward across entries like a real session: vanilla
    MySQL only emits `use <db>;` (or MariaDB's `# Schema:`) when the database
    actually changes, not on every logged statement, so a query without its
    own schema marker is running against whatever database the last marker
    set. `default_db` (the connection's OWN configured database) is
    deliberately NOT used to seed this — that's a guess about what a given
    log entry was running against, not something the log itself says, and
    would silently mislabel any entry logged before this parse ever saw a
    real `Schema:`/`use` marker. Entries with no marker seen yet stay
    `db_name: None`, which the frontend renders honestly as "No Database"
    rather than a fabricated one.
    """
    queries = []
    current_db = None
    for block in content.split("# Time:"):
        try:
            if "Query_time:" not in block:
                continue

            tm_raw   = re.search(r"^\s*([^\n]+)", block)
            last_seen = tm_raw.group(1).strip() if tm_raw else ""

            qt  = re.search(r"Query_time:\s*([\d.]+)", block)
            re_ = re.search(r"Rows_examined:\s*(\d+)", block)
            rs  = re.search(r"Rows_sent:\s*(\d+)", block)

            # "# User@Host: appuser[appuser] @ localhost [127.0.0.1]  Id: 42"
            # — hostname and IP are each optional (one or the other is often
            # blank depending on how the client connected), so prefer whichever
            # one is actually populated.
            user_m = _USER_HOST_RE.search(block)
            user_name, host = None, None
            if user_m:
                user_name = user_m.group(1) or None
                host = (user_m.group(2) or "").strip() or (user_m.group(3) or "").strip() or None

            schema_m = re.search(r"Schema:\s*(\S+)", block)
            if schema_m and schema_m.group(1) not in ("", "QC_hit:"):
                current_db = schema_m.group(1)
            else:
                use_m = re.search(r"^use\s+(\S+?);", block, re.MULTILINE | re.IGNORECASE)
                if use_m:
                    current_db = use_m.group(1).strip("`'\"")
            db_name = current_db

            sql_text = ""
            ts_m = re.search(r"SET timestamp=\d+;\n([\s\S]+?)(?:\n#|\Z)", block)
            if ts_m:
                sql_text = ts_m.group(1).strip().rstrip(";")
            else:
                sql_lines, past_header = [], False
                for line in block.split("\n"):
                    stripped = line.strip()
                    if stripped.startswith("#"):
                        past_header = True
                        continue
                    if not past_header or not stripped:
                        continue
                    if re.match(r"^(use\s|SET\s+timestamp)", stripped, re.IGNORECASE):
                        continue
                    sql_lines.append(stripped)
                sql_text = " ".join(sql_lines).rstrip(";").strip()

            banner_m = _MYSQLD_BANNER_RE.search(sql_text)
            if banner_m:
                sql_text = sql_text[:banner_m.start()].strip().rstrip(";").strip()

            admin_m = _ADMIN_COMMAND_RE.search(sql_text)
            if admin_m:
                sql_text = sql_text[:admin_m.start()].strip().rstrip(";").strip()

            if not sql_text:
                continue

            # The raw log records every individual execution, not a merged
            # per-shape digest — so this id identifies one logged EVENT
            # (db + query text + its own timestamp/duration), not a query
            # shape. It's deterministic for the same log content, which is
            # what the detail page's refresh/direct-link lookup needs.
            normalized_sql = re.sub(r"\s+", " ", sql_text).strip().lower()
            digest_key = f"{db_name}|{normalized_sql}|{last_seen}|{qt.group(1) if qt else ''}"
            digest_id = hashlib.md5(digest_key.encode("utf-8", errors="ignore")).hexdigest()[:16]

            queries.append({
                "digest_id":      digest_id,
                "db_name":        db_name,
                "sql_text":       sql_text,
                "avg_exec_sec":   float(qt.group(1)) if qt else 0.0,
                "max_exec_sec":   float(qt.group(1)) if qt else 0.0,
                "total_exec_sec": float(qt.group(1)) if qt else 0.0,
                "count_calls":    1,
                "rows_examined":  int(re_.group(1)) if re_ else 0,
                "rows_returned":  int(rs.group(1)) if rs else 0,
                "no_index_count": 0,
                "last_seen":      last_seen,
                "user_name":      user_name,
                "host":           host,
            })
        except Exception:
            pass
    return queries[::-1]


# ── Service functions ─────────────────────────────────────────────────────────

def get_slow_queries(conn_id: int, db: Session, live: bool = False) -> dict:
    """The MySQL/MariaDB Slow Query Log FILE is the one and only source here —
    never `performance_schema`/`sys`. Those catalogs summarize by DIGEST
    (normalized query shape) and can silently omit or merge entries depending
    on consumer/instrument state; the raw log file is the actual, complete
    record of every statement the server logged as slow, verbatim. Every
    parsed entry is kept regardless of its SQL verb/pattern (SELECT, INSERT,
    UPDATE, DELETE, REPLACE, DDL, subqueries, CTEs, anything) — the only
    exclusion is ActMon-internal/system traffic via `_split_internal` below."""
    from app.utils.agent_cache import get_snapshot as _get_snap
    if not live:
        cached = _get_snap(conn_id, "mysql_slow_queries", db)
        if cached is not None:
            if "normalized" not in cached:
                _normalize_mysql_rows(cached.get("file_queries") or [], cached)
            return cached

    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        raise HTTPException(404, "Connection not found")

    try:
        engine = db_proxy_service.engine_for(rec, lambda: create_engine(_mysql_url(rec), connect_args={"connect_timeout": 5}, poolclass=NullPool))
        with engine.connect() as conn:

            # slow log config
            var_rows = conn.execute(text(
                "SHOW VARIABLES WHERE Variable_name IN "
                "('slow_query_log','slow_query_log_file','long_query_time')"
            )).fetchall()
            vd        = {r[0]: r[1] for r in var_rows}
            slow_log  = vd.get("slow_query_log", "OFF")
            slow_file = vd.get("slow_query_log_file", "")
            long_time = float(vd.get("long_query_time", 10.0))

            # slow log file parsing
            file_queries, file_error = [], None
            full_slow_file = slow_file
            if slow_log == "ON" and slow_file:
                if not (slow_file.startswith("/") or (len(slow_file) > 1 and slow_file[1] == ":")):
                    try:
                        datadir = conn.execute(text("SELECT @@datadir")).scalar() or ""
                        full_slow_file = datadir.rstrip("/").rstrip("\\") + "/" + slow_file.lstrip("/")
                    except Exception:
                        pass

                if os.path.exists(full_slow_file):
                    try:
                        file_queries = _parse_slow_log_content(
                            open(full_slow_file, encoding="utf-8", errors="ignore").read(),
                            rec.database_name or "",
                        )
                    except Exception as e:
                        file_error = str(e)
                else:
                    try:
                        raw = conn.execute(text("SELECT LOAD_FILE(:p)"), {"p": full_slow_file}).scalar()
                        if raw is not None:
                            content_str = raw if isinstance(raw, str) else raw.decode("utf-8", errors="ignore")
                            file_queries = _parse_slow_log_content(content_str, rec.database_name or "")
                            if not file_queries:
                                file_error = "Log file read via LOAD_FILE() succeeded but no slow queries found yet."
                        else:
                            has_file_priv = False
                            try:
                                grants = conn.execute(text("SHOW GRANTS FOR CURRENT_USER()")).fetchall()
                                has_file_priv = any("FILE" in str(r) for r in grants)
                            except Exception:
                                pass
                            sfp = ""
                            try:
                                sfp_row = conn.execute(text("SHOW VARIABLES LIKE 'secure_file_priv'")).fetchone()
                                sfp = sfp_row[1] if sfp_row else ""
                            except Exception:
                                pass
                            if not has_file_priv:
                                file_error = (
                                    f"LOAD_FILE returned NULL — MySQL user lacks FILE privilege. "
                                    f"Run on the DB server: GRANT FILE ON *.* TO '{rec.username}'@'%'; FLUSH PRIVILEGES;"
                                )
                            elif sfp and sfp != "":
                                file_error = (
                                    f"LOAD_FILE returned NULL — secure_file_priv='{sfp}' blocks read. "
                                    "Fix: set secure_file_priv='' in /etc/mysql/mariadb.conf.d/50-server.cnf, restart MariaDB."
                                )
                            else:
                                file_error = (
                                    f"LOAD_FILE({full_slow_file}) returned NULL — file may not exist "
                                    "or OS permissions deny the MySQL process read access."
                                )
                    except Exception as e:
                        file_error = f"LOAD_FILE() error: {str(e)}"

                if not file_queries and rec.ssh_user and rec.ssh_password:
                    ssh_host = rec.ssh_host or rec.host
                    ssh_port = rec.ssh_port or 22
                    content_str, ssh_err = _read_file_via_ssh(
                        ssh_host, ssh_port, rec.ssh_user, rec.ssh_password, full_slow_file
                    )
                    if content_str:
                        file_queries = _parse_slow_log_content(content_str, rec.database_name or "")
                        file_error   = None
                    else:
                        file_error = (file_error or "") + f" | SSH error: {ssh_err}"

        # Split out ActMon's own monitoring/introspection traffic — the Slow
        # Queries page's job is to surface the MONITORED database's workload,
        # not the noise generated by monitoring it. This is the ONLY exclusion
        # applied — no filtering by SQL verb/pattern. The excluded side isn't
        # thrown away: it's returned separately (capped) so the UI can still
        # show "N ActMon queries hidden" rather than filtering silently.
        file_queries, internal_queries = _split_internal(file_queries)

        all_queries = file_queries
        # Agent-connected DBs don't need SSH: the agent already delivers the
        # log file over its own channel. The UI uses this to hide the SSH nag.
        agent_connected = (rec.registration_mode or "").lower() == "agent"
        if not agent_connected:
            from app.models.os_server_model import OsServer, DatabaseInstance
            inst = db.query(DatabaseInstance).filter(DatabaseInstance.connection_id == rec.id).first()
            if inst:
                srv = db.query(OsServer).filter(OsServer.id == inst.server_id).first()
                agent_connected = bool(srv and srv.collector == "agent")
        response = {
            "status": "success",
            "slow_log_config": {
                "enabled":             slow_log == "ON",
                "log_file":            full_slow_file,
                "slow_query_log_file": full_slow_file,
                "long_query_time":     long_time,
            },
            "source":                  "slow_query_log_file",
            "file_queries":            file_queries,
            "file_error":              file_error,
            "total":                   len(all_queries),
            "actmon_internal_count":   len(internal_queries),
            "actmon_internal_queries": sorted(
                internal_queries, key=lambda q: q.get("total_exec_sec", 0), reverse=True
            )[:20],
            "ssh_configured":          bool(rec.ssh_user and rec.ssh_password),
            "agent_connected":         agent_connected,
            "ssh_user":                rec.ssh_user or "",
            "ssh_host":                rec.ssh_host or rec.host,
        }
        _normalize_mysql_rows(all_queries, response)
        return response

    except Exception as e:
        raise HTTPException(500, f"MySQL error: {str(e)}")


def _normalize_mysql_rows(all_queries: list, response: dict) -> None:
    """Builds the shared cross-engine `normalized`/`capabilities` shape from
    the parsed slow-log-file entries. Mutates `response` in place; see
    slow_query_normalize.py."""
    source = response.get("source") or "slow_query_log_file"
    normalized = []
    for q in all_queries:
        avg_ms = (q.get("avg_exec_sec") or 0) * 1000
        normalized.append(build_normalized_row(
            query_id=str(q["digest_id"]) if q.get("digest_id") else None,
            query_text=q.get("sql_text"),
            database_name=q.get("db_name"),
            execution_count=q.get("count_calls"),
            total_execution_time=(q.get("total_exec_sec") or 0) * 1000 if q.get("total_exec_sec") is not None else None,
            average_execution_time=avg_ms,
            min_execution_time=(q.get("min_exec_sec") * 1000) if q.get("min_exec_sec") is not None else None,
            max_execution_time=(q.get("max_exec_sec") or 0) * 1000,
            rows_affected=q.get("rows_examined"),
            rows_returned=q.get("rows_returned"),
            user_name=q.get("user_name"),
            host=q.get("host"),
            first_seen=q.get("first_seen"),
            last_seen=q.get("last_seen"),
            source=source,
        ))
    attach_normalized(response, "mysql", normalized)


def _parse_iso_ts(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def list_slow_queries_filtered(
    conn_id: int, db: Session, live: bool = False,
    database_name: str = None, min_avg_ms: float = None, search: str = None,
    severity: str = None, date_from: str = None, date_to: str = None,
    sort_by: str = None, sort_dir: str = "desc", page: int = 1, page_size: int = 50,
) -> dict:
    """Wraps `get_slow_queries` with real server-side filter/sort/pagination
    over the normalized row list, so the frontend receives only the slice it
    actually needs (database/schema filter, min execution time, text search,
    severity, date range, sort, page) instead of always rendering the full
    collector fetch (already capped at 200 rows) and filtering client-side.
    Doesn't change `get_slow_queries` or its caching at all — this only
    reshapes what's returned from the SAME underlying data, so calling it
    with no filters and a page_size >= 200 is identical to calling
    `get_slow_queries` directly."""
    response = get_slow_queries(conn_id, db, live=live)
    all_normalized = response.get("normalized") or []
    normalized = list(all_normalized)

    if database_name:
        normalized = [r for r in normalized if (r.get("database_name") or "").lower() == database_name.lower()]
    if min_avg_ms:
        normalized = [r for r in normalized if (r.get("average_execution_time") or 0) >= min_avg_ms]
    if search:
        q = search.lower()
        normalized = [r for r in normalized if q in (r.get("query_text") or "").lower()]
    if severity and severity.lower() != "all":
        normalized = [r for r in normalized if (r.get("severity") or "").lower() == severity.lower()]
    if date_from or date_to:
        df = _parse_iso_ts(date_from)
        # A plain "YYYY-MM-DD" date_to means "through the end of that day" —
        # otherwise midnight itself would exclude every entry logged later
        # that same day.
        dt = _parse_iso_ts(f"{date_to}T23:59:59" if date_to and len(date_to) == 10 else date_to)
        def _in_range(r):
            ts = _parse_iso_ts(r.get("last_seen"))
            if ts is None:
                return False
            if df and ts.replace(tzinfo=None) < df.replace(tzinfo=None):
                return False
            if dt and ts.replace(tzinfo=None) > dt.replace(tzinfo=None):
                return False
            return True
        normalized = [r for r in normalized if _in_range(r)]

    sort_key_map = {
        "avg": "average_execution_time", "total": "total_execution_time",
        "count": "execution_count", "rows_examined": "rows_affected",
        "rows_returned": "rows_returned", "max": "max_execution_time",
        "last_seen": "last_seen",
    }
    key = sort_key_map.get(sort_by, "average_execution_time")
    reverse = (sort_dir != "asc")
    if key == "last_seen":
        normalized.sort(key=lambda r: r.get(key) or "", reverse=reverse)
    else:
        normalized.sort(key=lambda r: r.get(key) if r.get(key) is not None else -1, reverse=reverse)

    total_filtered = len(normalized)
    page = max(1, page)
    page_size = max(1, min(page_size, 500))
    # If the requested page is beyond the last page these filters actually
    # produce (e.g. a stale page number from before a filter narrowed the
    # result set), clamp to the real last page rather than returning an
    # empty slice for a page that doesn't exist — the response's own `page`
    # always reflects what was ACTUALLY served.
    last_page = max(1, -(-total_filtered // page_size)) if total_filtered else 1
    if page > last_page:
        page = last_page
    start = (page - 1) * page_size
    page_rows = normalized[start:start + page_size]

    # Available database/schema names for the filter dropdown — computed from
    # the FULL fetched set, not the already-filtered slice, so picking one
    # schema doesn't make the others disappear from the dropdown options.
    available_databases = sorted({r.get("database_name") for r in all_normalized if r.get("database_name")})

    out = dict(response)
    out["normalized"] = page_rows
    out["normalized_total"] = total_filtered
    out["available_databases"] = available_databases
    out["page"] = page
    out["page_size"] = page_size
    out["has_next"] = (page * page_size) < total_filtered
    out["has_previous"] = page > 1
    return out


def get_ssh_config_data(conn_id: int, db: Session) -> dict:
    from app.services.common.credential_encryption_service import credential_encryption

    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        raise HTTPException(404, "Connection not found")
    return {
        "ssh_host":   rec.ssh_host or rec.host,
        "ssh_port":   rec.ssh_port or 22,
        "ssh_user":   rec.ssh_user or "",
        "ssh_password": credential_encryption.mask(rec.ssh_password) or "",
        "configured": bool(rec.ssh_user and rec.ssh_password),
    }


def save_ssh_config_data(
    conn_id: int,
    ssh_host: str,
    ssh_port: int,
    ssh_user: str,
    ssh_password: str,
    db: Session,
) -> dict:
    from app.services.common.credential_encryption_service import credential_encryption

    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        raise HTTPException(404, "Connection not found")

    # get_ssh_config_data (below) returns "***" for an already-configured
    # password — if the caller round-trips that placeholder unchanged (e.g.
    # opened the modal and saved without touching the password field), keep
    # the real stored credential instead of overwriting it with the literal
    # mask string.
    effective_password = rec.ssh_password if credential_encryption.looks_like_mask(ssh_password) else ssh_password

    resolved_host = ssh_host or rec.host
    content, err = _read_file_via_ssh(resolved_host, ssh_port or 22, ssh_user, effective_password, "/etc/hostname")
    if err and not content:
        return {"status": "error", "message": f"SSH test failed: {err}"}

    rec.ssh_host     = ssh_host or None
    rec.ssh_port     = ssh_port or 22
    rec.ssh_user     = ssh_user
    rec.ssh_password = effective_password
    db.commit()
    return {"status": "success", "message": "SSH credentials saved and verified"}


def analyze_slow_query_with_groq(conn_id: int, payload: dict, db: Session) -> dict:
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": "Connection not found"}

    try:
        from groq import Groq
        groq_client = Groq(api_key=os.getenv("GROQ_API_KEY", ""))

        rows_examined  = payload.get("rows_examined", 0) or 0
        rows_returned  = payload.get("rows_returned", 0) or 0
        explain_rows   = payload.get("explain_rows", []) or []
        efficiency     = round(rows_returned / max(rows_examined, 1) * 100, 1) if rows_examined else 100
        explain_text   = json.dumps(explain_rows, indent=2) if explain_rows else "Not run yet"

        prompt = f"""You are a world-class MySQL/MariaDB DBA expert. Analyze this slow query deeply and return ONLY valid JSON — no markdown, no code blocks.

=== QUERY CONTEXT ===
Host: {rec.host}:{rec.port}
Database: {payload.get('db_name') or 'unknown'}
SQL: {payload.get('sql_text', '')}

=== PERFORMANCE METRICS ===
Execution Count: {payload.get('count_calls', 0):,}
Average Execution Time: {payload.get('avg_exec_sec', 0.0):.4f}s
Maximum Execution Time: {payload.get('max_exec_sec', 0.0):.4f}s
Total Cumulative Time: {payload.get('total_exec_sec', 0.0):.4f}s
Rows Examined: {rows_examined:,}
Rows Returned: {rows_returned:,}
Efficiency Ratio: {efficiency}% (rows_returned / rows_examined)
No-Index Scans: {payload.get('no_index_count', 0)}

=== EXPLAIN OUTPUT ===
{explain_text}

Return this exact JSON structure:
{{
  "severity": "critical|high|medium|low",
  "severity_reason": "why this severity was assigned",
  "summary": "one-sentence description of what the query does and why it is slow",
  "root_cause": "detailed root cause — what exactly is making this query slow",
  "issues": [
    {{
      "type": "FULL_TABLE_SCAN|MISSING_INDEX|REDUNDANT_INDEX|FILESORT|TEMP_TABLE|N_PLUS_1|LOCK_CONTENTION|BAD_JOIN|LARGE_RESULT_SET|OTHER",
      "table": "affected table name or null",
      "description": "detailed description of the issue",
      "severity": "critical|high|medium|low",
      "evidence": "exact value from EXPLAIN or metrics that proves this issue"
    }}
  ],
  "index_recommendations": [
    {{
      "table": "table_name",
      "columns": ["col1", "col2"],
      "index_type": "BTREE|FULLTEXT|HASH",
      "create_sql": "CREATE INDEX idx_name ON table_name (col1, col2);",
      "reason": "why this specific index will help",
      "estimated_row_reduction": "e.g. from 50000 to ~10 rows scanned",
      "estimated_improvement": "e.g. 99.98% reduction in rows examined"
    }}
  ],
  "query_rewrite": {{
    "applicable": true,
    "optimized_sql": "rewritten query or empty string if not applicable",
    "changes_made": ["list", "of", "changes"],
    "explanation": "what was changed and why it will be faster",
    "expected_gain": "e.g. 10x–50x faster"
  }},
  "explain_row_analysis": [
    {{
      "table": "table_name",
      "access_type": "ALL|index|range|ref|eq_ref|const",
      "assessment": "good|warning|critical",
      "finding": "what this EXPLAIN row tells us"
    }}
  ],
  "schema_suggestions": [
    "Any table design or schema changes that would help"
  ],
  "priority_actions": [
    "1. Most impactful thing to do first",
    "2. Second action",
    "3. Third action"
  ],
  "business_impact": "impact on application performance and end users",
  "estimated_overall_improvement": "overall expected improvement after all fixes",
  "validation_queries": [
    "SQL query to verify the optimization worked"
  ]
}}"""

        response = groq_client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=3000,
            reasoning_effort="low",
        )

        raw = response.choices[0].message.content.strip()
        if raw.startswith("```"):
            parts = raw.split("```")
            raw = parts[1]
            if raw.startswith("json"):
                raw = raw[4:]
        analysis = json.loads(raw.strip())
        return {"status": "success", "analysis": analysis}

    except Exception as e:
        return {"status": "error", "error": str(e)}


def analyze_slow_query_with_context(conn_id: int, payload: dict, analysis: dict, db: Session) -> dict:
    """Same Groq call convention as `analyze_slow_query_with_groq` above
    (same model/temperature, prompt + `json.loads()` + error fallback) — this
    is an ADDITIONAL function, not a replacement. `analyze_slow_query_with_groq`
    is unchanged and still backs the Overview/Explorer tabs' quick "AI
    Analysis" flow, which never gathers this context.

    This one is sent the FULL deterministic evidence bundle from
    `mysql_slow_query_analysis_service.analyze_query_full` (EXPLAIN, real
    table/index metadata, query-vs-index coverage, duplicate indexes, and the
    rule-based diagnosis) — Groq is told explicitly to reason only from that
    evidence, never to invent a table/column/index/metric, and never to
    recommend an index the coverage check already shows exists."""
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": "Connection not found"}

    try:
        from groq import Groq
        groq_client = Groq(api_key=os.getenv("GROQ_API_KEY", ""))

        rows_examined = payload.get("rows_examined", 0) or 0
        rows_returned = payload.get("rows_returned", 0) or 0
        efficiency = round(rows_returned / max(rows_examined, 1) * 100, 1) if rows_examined else 100

        explain = analysis.get("explain") or {}
        plan_mode = explain.get("mode", "estimate")
        explain_text = json.dumps(explain.get("tables", []), indent=2, default=str)[:3000]
        tables_text = json.dumps(analysis.get("tables", []), indent=2, default=str)[:4000]
        coverage_text = json.dumps(analysis.get("index_coverage", []), indent=2, default=str)[:2000]
        duplicate_text = json.dumps(analysis.get("duplicate_indexes", []), indent=2, default=str)[:1500]
        diagnosis_text = json.dumps((analysis.get("diagnosis") or {}).get("issues", []), indent=2, default=str)[:3000]

        prompt = f"""You are a world-class MySQL/MariaDB DBA. You are given REAL, ALREADY-COLLECTED database
evidence for one slow query — the execution plan, the actual tables/columns/indexes that exist, a
deterministic coverage check of the query's predicates against those real indexes, already-detected
duplicate indexes, and a rule-based diagnosis. Reason ONLY from this evidence — do not invent a
table, column, index, or metric that is not listed below, and do not recommend an index the coverage
check already shows exists. Return ONLY valid JSON, no markdown, no code fences.

=== QUERY ===
Database: {payload.get('db_name') or 'unknown'}
SQL: {payload.get('sql_text', '')}

=== PERFORMANCE METRICS ===
Execution Count: {payload.get('count_calls', 0):,}
Average Execution Time: {payload.get('avg_exec_sec', 0.0):.4f}s
Total Cumulative Time: {payload.get('total_exec_sec', 0.0):.4f}s
Rows Examined: {rows_examined:,}
Rows Returned: {rows_returned:,}
Efficiency Ratio: {efficiency}%

=== EXECUTION PLAN ({plan_mode.upper()} — {"actually executed" if plan_mode == "analyze" else "estimated, statement NOT executed"}) ===
{explain_text}

=== TABLE METADATA (real, from information_schema) ===
{tables_text}

=== QUERY-VS-INDEX COVERAGE (already computed from real index metadata — trust this, do not recompute) ===
{coverage_text}

=== DUPLICATE/REDUNDANT INDEXES ALREADY DETECTED ON THESE TABLES ===
{duplicate_text}

=== RULE-BASED DIAGNOSIS (already-detected issues, each evidence-backed) ===
{diagnosis_text}

Return this exact JSON structure:
{{
  "summary": "one-sentence description of what the query does and the main reason it is slow",
  "root_cause": "detailed root cause referencing the ACTUAL evidence above, not generic advice",
  "recommendations": [
    {{
      "priority": "critical|high|medium|low",
      "problem": "the specific problem",
      "evidence": "the exact evidence from above that supports this",
      "recommendation": "what to do",
      "expected_benefit": "what improves and roughly how much",
      "risk": "any downside or trade-off",
      "existing_index_considered": "which existing index (if any) was checked before this recommendation, or 'none applicable'",
      "example": "an example SQL statement, or empty string if not applicable"
    }}
  ],
  "query_rewrite": {{
    "applicable": true,
    "optimized_sql": "rewritten query, or empty string if no rewrite is warranted",
    "changes_made": ["list of specific changes"],
    "explanation": "what changed and why it should be faster — grounded in the evidence, not a generic claim"
  }},
  "risks_and_testing": ["what to test/verify before applying any recommendation in production"],
  "estimated_overall_improvement": "a grounded estimate, or 'uncertain without testing' if the evidence doesn't support a number"
}}"""

        response = groq_client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=3000,
            reasoning_effort="low",
        )
        raw = response.choices[0].message.content.strip()
        if raw.startswith("```"):
            parts = raw.split("```")
            raw = parts[1]
            if raw.startswith("json"):
                raw = raw[4:]
        result = json.loads(raw.strip())
        return {"status": "success", "analysis": result}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def explain_and_analyze_query(conn_id: int, sql_text: str, db_name: str, db: Session) -> dict:
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": "Connection not found"}

    pw = quote_plus(rec.password or "")
    resolved_db = db_name or rec.database_name or ""
    url = f"mysql+pymysql://{rec.username}:{pw}@{rec.host}:{rec.port}/{resolved_db}"
    engine = db_proxy_service.engine_for(rec, lambda: create_engine(url, connect_args={"connect_timeout": 5}, poolclass=NullPool))

    explain_rows, explain_error = [], None
    try:
        with engine.connect() as conn:
            if resolved_db:
                try:
                    conn.execute(text(f"USE `{resolved_db}`"))
                except Exception:
                    pass
            rows = conn.execute(text(f"EXPLAIN {sql_text}")).fetchall()
            explain_rows = [dict(r._mapping) for r in rows]
    except Exception as e:
        explain_error = str(e)

    hints = []
    stats = {
        "has_full_scan":       False,
        "has_full_index_scan": False,
        "has_filesort":        False,
        "has_temp_table":      False,
        "has_no_index":        False,
        "tables_scanned":      [],
        "total_rows_estimate": 0,
    }

    for row in explain_rows:
        t         = row.get("table") or row.get("Table") or "?"
        typ       = str(row.get("type") or row.get("Type") or "").upper()
        extra     = str(row.get("Extra") or "")
        possible  = row.get("possible_keys") or row.get("possible_Keys")
        key       = row.get("key") or row.get("Key")
        rows_est  = int(row.get("rows") or row.get("Rows") or 0)
        stats["total_rows_estimate"] += rows_est

        if typ == "ALL":
            stats["has_full_scan"] = True
            stats["tables_scanned"].append(t)
            hints.append({
                "level": "critical", "type": "FULL_TABLE_SCAN", "table": t,
                "title": f"Full table scan on `{t}`",
                "text":  f"MySQL scans every row (~{rows_est:,} rows). No index is being used.",
                "fix":   f"Add an index on the WHERE/JOIN columns for `{t}`.",
            })
        elif typ == "INDEX":
            stats["has_full_index_scan"] = True
            hints.append({
                "level": "warning", "type": "FULL_INDEX_SCAN", "table": t,
                "title": f"Full index scan on `{t}`",
                "text":  f"Using index `{key}` but scanning all index entries (~{rows_est:,} rows).",
                "fix":   "Use a more selective index or add a covering index.",
            })

        if "Using filesort" in extra:
            stats["has_filesort"] = True
            hints.append({
                "level": "warning", "type": "FILESORT", "table": t,
                "title": f"Filesort on `{t}`",
                "text":  "Results sorted in memory/disk after retrieval — no index covers the ORDER BY.",
                "fix":   "Add an index that covers both WHERE and ORDER BY columns.",
            })
        if "Using temporary" in extra:
            stats["has_temp_table"] = True
            hints.append({
                "level": "warning", "type": "TEMP_TABLE", "table": t,
                "title": f"Temporary table for `{t}`",
                "text":  "MySQL creates a temporary table for GROUP BY or DISTINCT. Can cause disk I/O.",
                "fix":   "Add a composite index covering the GROUP BY/DISTINCT columns.",
            })
        if possible and not key:
            stats["has_no_index"] = True
            hints.append({
                "level": "high", "type": "UNUSED_INDEX", "table": t,
                "title": f"Available indexes ignored on `{t}`",
                "text":  f"Possible indexes: {possible} — but none selected. Optimizer chose full scan.",
                "fix":   "Use FORCE INDEX or rethink query structure to make index selective.",
            })
        if not possible and typ == "ALL":
            hints.append({
                "level": "critical", "type": "NO_INDEX_AT_ALL", "table": t,
                "title": f"No usable index exists on `{t}`",
                "text":  "Table has no indexes matching this query's WHERE/JOIN conditions.",
                "fix":   f"CREATE INDEX on the columns used in WHERE/JOIN for `{t}`.",
            })

    return {
        "status": "success",
        "explain_rows":  explain_rows,
        "explain_error": explain_error,
        "hints":         hints,
        "stats":         stats,
    }


def build_export_csv(conn_id: int, period: str, db: Session) -> dict:
    """Returns {"csv_bytes": bytes, "filename": str} or raises HTTPException.

    Sources exclusively from the Slow Query Log file, same as `get_slow_queries`
    — never performance_schema/sys — so the export always mirrors exactly what
    the Slow Queries page itself is showing."""
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        raise HTTPException(404, "Connection not found")

    pw = quote_plus(rec.password or "")
    url = f"mysql+pymysql://{rec.username}:{pw}@{rec.host}:{rec.port}/{rec.database_name or ''}"
    engine = db_proxy_service.engine_for(rec, lambda: create_engine(url, connect_args={"connect_timeout": 5}, poolclass=NullPool))

    period_map = {"hourly": 1, "daily": 24, "weekly": 168, "all": None}
    hours  = period_map[period]
    queries, source = [], "slow_query_log_file"

    try:
        with engine.connect() as conn:
            var_rows = conn.execute(text(
                "SHOW VARIABLES WHERE Variable_name IN ('slow_query_log','slow_query_log_file')"
            )).fetchall()
            vd       = {r[0]: r[1] for r in var_rows}
            log_file = vd.get("slow_query_log_file", "")

            if log_file and not (log_file.startswith("/") or (len(log_file) > 1 and log_file[1] == ":")):
                try:
                    datadir  = conn.execute(text("SELECT @@datadir")).scalar() or ""
                    log_file = datadir.rstrip("/").rstrip("\\") + "/" + log_file.lstrip("/")
                except Exception:
                    pass

            if log_file:
                content_str = None
                if os.path.exists(log_file):
                    content_str = open(log_file, encoding="utf-8", errors="ignore").read()
                else:
                    raw = conn.execute(text("SELECT LOAD_FILE(:p)"), {"p": log_file}).scalar()
                    if raw is not None:
                        content_str = raw if isinstance(raw, str) else raw.decode("utf-8", errors="ignore")
                    if not content_str and rec.ssh_user and rec.ssh_password:
                        ssh_host = rec.ssh_host or rec.host
                        c, _     = _read_file_via_ssh(ssh_host, rec.ssh_port or 22, rec.ssh_user, rec.ssh_password, log_file)
                        content_str = c

                if content_str:
                    queries = _parse_slow_log_content(content_str, rec.database_name or "")
                    if hours:
                        cutoff     = datetime.now() - timedelta(hours=hours)
                        filtered_q = []
                        for q in queries:
                            try:
                                for fmt in ("%y%m%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
                                    try:
                                        ts = datetime.strptime(q["last_seen"].strip(), fmt)
                                        if ts >= cutoff:
                                            filtered_q.append(q)
                                        break
                                    except ValueError:
                                        continue
                            except Exception:
                                filtered_q.append(q)
                        queries = filtered_q
    except Exception as e:
        raise HTTPException(500, str(e))

    # Mirror the UI's primary view: the export is a "slow query" report for
    # the monitored workload, not a dump of ActMon's own polling traffic.
    queries, _dropped = _split_internal(queries)

    fields = ["db_name", "sql_text", "count_calls", "avg_exec_sec",
              "max_exec_sec", "total_exec_sec", "rows_examined",
              "rows_returned", "no_index_count", "last_seen"]

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([f"# ACTMON Slow Query Report — {rec.host}:{rec.port}"])
    writer.writerow([f"# Period: {period.upper()}  |  Source: {source}  |  Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"])
    writer.writerow([f"# Total queries: {len(queries)}"])
    writer.writerow([])
    writer.writerow(fields)
    for q in queries:
        writer.writerow([q.get(f, "") for f in fields])

    fname = f"slow_queries_{rec.host}_{period}_{datetime.now().strftime('%Y%m%d_%H%M')}.csv"
    return {"csv_bytes": output.getvalue().encode("utf-8"), "filename": fname}
