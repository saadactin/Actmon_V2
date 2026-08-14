import csv
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
from app.services.common.actmon_internal_tables import mysql_exclude_internal_tables_sql
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
    r"^\s*(SHOW|EXPLAIN|DESC|DESCRIBE|ANALYZE\s+TABLE|OPTIMIZE\s+TABLE|CHECK\s+TABLE|FLUSH|KILL)\b",
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


def is_actmon_internal_query(db_name: str, sql_text: str) -> bool:
    """True if this statement is ActMon's own monitoring/introspection traffic
    rather than the monitored database's application workload — see the
    module docstring above for the classification rules."""
    if (db_name or "").strip().lower() in ACTMON_SYSTEM_SCHEMAS:
        return True
    text_ = (sql_text or "").strip()
    if not text_:
        return False
    if _SYSTEM_SCHEMA_REF_RE.search(text_):
        return True
    if _ADMIN_VERB_RE.match(text_):
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
    """Parse MySQL/MariaDB slow query log text into a list of query dicts."""
    queries = []
    for block in content.split("# Time:"):
        try:
            if "Query_time:" not in block:
                continue

            tm_raw   = re.search(r"^\s*([^\n]+)", block)
            last_seen = tm_raw.group(1).strip() if tm_raw else ""

            qt  = re.search(r"Query_time:\s*([\d.]+)", block)
            re_ = re.search(r"Rows_examined:\s*(\d+)", block)
            rs  = re.search(r"Rows_sent:\s*(\d+)", block)

            db_name  = default_db
            schema_m = re.search(r"Schema:\s*(\S+)", block)
            if schema_m and schema_m.group(1) not in ("", "QC_hit:"):
                db_name = schema_m.group(1)
            else:
                use_m = re.search(r"^use\s+(\S+?);", block, re.MULTILINE | re.IGNORECASE)
                if use_m:
                    db_name = use_m.group(1).strip("`'\"")

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

            if not sql_text:
                continue

            queries.append({
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
            })
        except Exception:
            pass
    return queries[::-1]


# ── Service functions ─────────────────────────────────────────────────────────

def get_slow_queries(conn_id: int, db: Session, live: bool = False) -> dict:
    from app.utils.agent_cache import get_snapshot as _get_snap
    if not live:
        cached = _get_snap(conn_id, "mysql_slow_queries", db)
        if cached is not None:
            if "normalized" not in cached:
                _normalize_mysql_rows(
                    cached.get("perf_schema_queries") or cached.get("file_queries") or [], cached
                )
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

            # performance_schema consumer status
            perf_consumers, perf_schema_enabled = {}, False
            try:
                ps_row = conn.execute(text("SHOW VARIABLES LIKE 'performance_schema'")).fetchone()
                perf_schema_enabled = (ps_row[1] if ps_row else "OFF") == "ON"
            except Exception:
                pass

            try:
                c_rows = conn.execute(text(
                    "SELECT NAME, ENABLED FROM performance_schema.setup_consumers"
                )).fetchall()
                perf_consumers = {r[0]: r[1] for r in c_rows}
            except Exception:
                pass

            # auto-enable disabled consumers
            consumers_enabled = False
            statement_consumers = {
                k: v for k, v in perf_consumers.items()
                if "statement" in k.lower() or "digest" in k.lower()
            }
            if statement_consumers and any(v == "NO" for v in statement_consumers.values()):
                try:
                    conn.execute(text("""
                        UPDATE performance_schema.setup_consumers
                        SET ENABLED = 'YES'
                        WHERE ENABLED = 'NO'
                          AND (NAME LIKE '%statement%'
                            OR NAME LIKE '%digest%'
                            OR NAME IN ('global_instrumentation','thread_instrumentation'))
                    """))
                    try:
                        conn.execute(text("""
                            UPDATE performance_schema.setup_instruments
                            SET ENABLED = 'YES', TIMED = 'YES'
                            WHERE NAME LIKE 'statement/%'
                        """))
                    except Exception:
                        pass
                    conn.commit()
                    consumers_enabled = True
                except Exception:
                    pass

            # performance schema queries
            perf_queries, perf_error = [], None
            try:
                rows = conn.execute(text(f"""
                    SELECT
                        DIGEST                                     AS digest_id,
                        IFNULL(SCHEMA_NAME,'(all)')               AS db_name,
                        DIGEST_TEXT                               AS sql_text,
                        COUNT_STAR                                AS count_calls,
                        ROUND(AVG_TIMER_WAIT / 1e12, 4)          AS avg_exec_sec,
                        ROUND(MIN_TIMER_WAIT / 1e12, 4)          AS min_exec_sec,
                        ROUND(MAX_TIMER_WAIT / 1e12, 4)          AS max_exec_sec,
                        ROUND(SUM_TIMER_WAIT / 1e12, 4)          AS total_exec_sec,
                        SUM_ROWS_EXAMINED                        AS rows_examined,
                        SUM_ROWS_SENT                            AS rows_returned,
                        COALESCE(SUM_NO_GOOD_INDEX_USED, 0)
                          + COALESCE(SUM_NO_INDEX_USED, 0)       AS no_index_count,
                        DATE_FORMAT(FIRST_SEEN,'%Y-%m-%d %H:%i:%s') AS first_seen,
                        DATE_FORMAT(LAST_SEEN,'%Y-%m-%d %H:%i:%s') AS last_seen
                    FROM performance_schema.events_statements_summary_by_digest
                    WHERE DIGEST_TEXT IS NOT NULL
                      AND COUNT_STAR > 0
                      AND {mysql_exclude_internal_tables_sql("DIGEST_TEXT")}
                    ORDER BY AVG_TIMER_WAIT DESC
                    LIMIT 200
                """)).fetchall()
                perf_queries = [dict(r._mapping) for r in rows]
            except Exception as e:
                perf_error = str(e)

            if not perf_queries and not perf_error:
                try:
                    rows = conn.execute(text(f"""
                        SELECT
                            IFNULL(db,'(all)')                   AS db_name,
                            query                                AS sql_text,
                            exec_count                           AS count_calls,
                            ROUND(avg_latency / 1e12, 4)        AS avg_exec_sec,
                            ROUND(max_latency / 1e12, 4)        AS max_exec_sec,
                            ROUND(total_latency / 1e12, 4)      AS total_exec_sec,
                            rows_examined                        AS rows_examined,
                            rows_sent                            AS rows_returned,
                            no_index_used_count                  AS no_index_count,
                            last_seen                            AS last_seen
                        FROM sys.x$statement_analysis
                        WHERE {mysql_exclude_internal_tables_sql("query")}
                        ORDER BY avg_latency DESC
                        LIMIT 200
                    """)).fetchall()
                    if rows:
                        perf_queries = [dict(r._mapping) for r in rows]
                        perf_error   = None
                except Exception:
                    pass

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
        # not the noise generated by monitoring it. The excluded side isn't
        # thrown away: it's returned separately (capped) so the UI can still
        # show "N ActMon queries hidden" rather than filtering silently.
        perf_queries, perf_internal   = _split_internal(perf_queries)
        file_queries, file_internal   = _split_internal(file_queries)
        internal_queries = perf_internal + file_internal

        all_queries = perf_queries if perf_queries else file_queries
        # Agent-connected DBs don't need SSH: the agent already delivers query
        # internals via performance_schema. The UI uses this to hide the SSH nag.
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
            "source":                  "slow_query_log_file" if file_queries else ("performance_schema" if perf_queries else "none"),
            "perf_schema_queries":     perf_queries,
            "perf_schema_error":       perf_error,
            "perf_schema_enabled":     perf_schema_enabled,
            "perf_consumers":          perf_consumers,
            "consumers_auto_enabled":  consumers_enabled,
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
    whichever row set (performance_schema digests or parsed slow-log-file
    entries) this call ended up using. Both share the same field names
    (db_name, sql_text, avg_exec_sec, ...), so one mapping covers either
    source. Mutates `response` in place; see slow_query_normalize.py."""
    source = response.get("source") or "performance_schema"
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
            first_seen=q.get("first_seen"),
            last_seen=q.get("last_seen"),
            source=source,
        ))
    attach_normalized(response, "mysql", normalized)


def get_ssh_config_data(conn_id: int, db: Session) -> dict:
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        raise HTTPException(404, "Connection not found")
    return {
        "ssh_host":   rec.ssh_host or rec.host,
        "ssh_port":   rec.ssh_port or 22,
        "ssh_user":   rec.ssh_user or "",
        "ssh_password": "***" if rec.ssh_password else "",
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
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        raise HTTPException(404, "Connection not found")

    resolved_host = ssh_host or rec.host
    content, err = _read_file_via_ssh(resolved_host, ssh_port or 22, ssh_user, ssh_password, "/etc/hostname")
    if err and not content:
        return {"status": "error", "message": f"SSH test failed: {err}"}

    rec.ssh_host     = ssh_host or None
    rec.ssh_port     = ssh_port or 22
    rec.ssh_user     = ssh_user
    rec.ssh_password = ssh_password
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
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=3000,
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
    """Returns {"csv_bytes": bytes, "filename": str} or raises HTTPException."""
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        raise HTTPException(404, "Connection not found")

    pw = quote_plus(rec.password or "")
    url = f"mysql+pymysql://{rec.username}:{pw}@{rec.host}:{rec.port}/{rec.database_name or ''}"
    engine = db_proxy_service.engine_for(rec, lambda: create_engine(url, connect_args={"connect_timeout": 5}, poolclass=NullPool))

    period_map = {"hourly": 1, "daily": 24, "weekly": 168, "all": None}
    hours  = period_map[period]
    queries, source = [], "unknown"

    try:
        with engine.connect() as conn:
            where_clause = f"AND LAST_SEEN >= NOW() - INTERVAL {hours} HOUR" if hours else ""
            try:
                rows = conn.execute(text(f"""
                    SELECT
                        IFNULL(SCHEMA_NAME,'(all)')                     AS db_name,
                        DIGEST_TEXT                                     AS sql_text,
                        COUNT_STAR                                      AS count_calls,
                        ROUND(AVG_TIMER_WAIT / 1e12, 4)                AS avg_exec_sec,
                        ROUND(MAX_TIMER_WAIT / 1e12, 4)                AS max_exec_sec,
                        ROUND(SUM_TIMER_WAIT / 1e12, 4)                AS total_exec_sec,
                        SUM_ROWS_EXAMINED                              AS rows_examined,
                        SUM_ROWS_SENT                                  AS rows_returned,
                        COALESCE(SUM_NO_INDEX_USED,0)+COALESCE(SUM_NO_GOOD_INDEX_USED,0) AS no_index_count,
                        DATE_FORMAT(LAST_SEEN,'%Y-%m-%d %H:%i:%s')    AS last_seen
                    FROM performance_schema.events_statements_summary_by_digest
                    WHERE DIGEST_TEXT IS NOT NULL
                      AND COUNT_STAR > 0
                      AND {mysql_exclude_internal_tables_sql("DIGEST_TEXT")}
                      {where_clause}
                    ORDER BY AVG_TIMER_WAIT DESC
                    LIMIT 1000
                """)).fetchall()
                queries = [dict(r._mapping) for r in rows]
                source  = "performance_schema"
            except Exception:
                pass

            if not queries:
                try:
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
                            source  = "slow_query_log_file"
                            if hours:
                                cutoff     = datetime.now() - timedelta(hours=hours)
                                filtered_q = []
                                for q in queries:
                                    try:
                                        for fmt in ("%y%m%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%y%m%d %H:%M:%S"):
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
                except Exception:
                    pass
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
