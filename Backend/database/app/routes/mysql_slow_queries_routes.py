from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from urllib.parse import quote_plus
from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
import os
import re

router = APIRouter(
    prefix="/api/v1/connections/mysql",
    tags=["MySQL Slow Queries"]
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _mysql_url(c):
    pw = quote_plus(c.password or "")
    return f"mysql+pymysql://{c.username}:{pw}@{c.host}:{c.port}/{c.database_name or ''}"


@router.get("/{conn_id}/slow-queries")
def get_slow_queries(conn_id: int, db: Session = Depends(get_db)):
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        raise HTTPException(404, "Connection not found")

    try:
        engine = create_engine(_mysql_url(rec), connect_args={"connect_timeout": 5})
        with engine.connect() as conn:

            # ── Slow log config ──────────────────────────────────
            var_rows = conn.execute(text(
                "SHOW VARIABLES WHERE Variable_name IN "
                "('slow_query_log','slow_query_log_file','long_query_time')"
            )).fetchall()
            vd = {r[0]: r[1] for r in var_rows}
            slow_log  = vd.get("slow_query_log", "OFF")
            slow_file = vd.get("slow_query_log_file", "")
            long_time = float(vd.get("long_query_time", 10.0))

            # ── Performance Schema: check consumer status ────────
            perf_consumers = {}
            perf_schema_enabled = False
            try:
                # Check if performance_schema itself is on
                ps_row = conn.execute(text(
                    "SHOW VARIABLES LIKE 'performance_schema'"
                )).fetchone()
                perf_schema_enabled = (ps_row[1] if ps_row else 'OFF') == 'ON'
            except Exception:
                pass

            try:
                # Get ALL consumers (MariaDB and MySQL have different names)
                c_rows = conn.execute(text(
                    "SELECT NAME, ENABLED FROM performance_schema.setup_consumers"
                )).fetchall()
                perf_consumers = {r[0]: r[1] for r in c_rows}
            except Exception:
                pass

            # ── Auto-enable consumers if any are disabled ────────
            consumers_enabled = False
            statement_consumers = {
                k: v for k, v in perf_consumers.items()
                if 'statement' in k.lower() or 'digest' in k.lower()
            }
            if statement_consumers and any(v == 'NO' for v in statement_consumers.values()):
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

            # ── Performance Schema queries (all schemas) ─────────
            perf_queries, perf_error = [], None
            try:
                rows = conn.execute(text("""
                    SELECT
                        IFNULL(SCHEMA_NAME,'(all)')               AS db_name,
                        DIGEST_TEXT                               AS sql_text,
                        COUNT_STAR                                AS count_calls,
                        ROUND(AVG_TIMER_WAIT / 1e12, 4)          AS avg_exec_sec,
                        ROUND(MAX_TIMER_WAIT / 1e12, 4)          AS max_exec_sec,
                        ROUND(SUM_TIMER_WAIT / 1e12, 4)          AS total_exec_sec,
                        SUM_ROWS_EXAMINED                        AS rows_examined,
                        SUM_ROWS_SENT                            AS rows_returned,
                        COALESCE(SUM_NO_GOOD_INDEX_USED, 0)
                          + COALESCE(SUM_NO_INDEX_USED, 0)       AS no_index_count,
                        DATE_FORMAT(LAST_SEEN,'%Y-%m-%d %H:%i:%s') AS last_seen
                    FROM performance_schema.events_statements_summary_by_digest
                    WHERE DIGEST_TEXT IS NOT NULL
                      AND COUNT_STAR > 0
                    ORDER BY AVG_TIMER_WAIT DESC
                    LIMIT 200
                """)).fetchall()
                perf_queries = [dict(r._mapping) for r in rows]
            except Exception as e:
                perf_error = str(e)

            # If still empty, try MariaDB-specific performance_schema table
            if not perf_queries and not perf_error:
                try:
                    rows = conn.execute(text("""
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
                        ORDER BY avg_latency DESC
                        LIMIT 200
                    """)).fetchall()
                    if rows:
                        perf_queries = [dict(r._mapping) for r in rows]
                        perf_error = None
                except Exception:
                    pass

        # ── Parse slow log file if locally accessible ────────────
        file_queries, file_error = [], None
        if slow_log == "ON" and slow_file:
            if os.path.exists(slow_file):
                try:
                    file_queries = _parse_slow_log_file(slow_file, rec.database_name)
                except Exception as e:
                    file_error = str(e)
            else:
                file_error = (
                    f"Log file not accessible from backend server ({slow_file}). "
                    "MySQL is likely remote — showing Performance Schema data instead."
                )

        all_queries = perf_queries if perf_queries else file_queries
        return {
            "status": "success",
            "slow_log_config": {
                "enabled":         slow_log == "ON",
                "log_file":        slow_file,
                "long_query_time": long_time,
            },
            "source": "slow_log + performance_schema" if file_queries else "performance_schema",
            "perf_schema_queries":    perf_queries,
            "perf_schema_error":      perf_error,
            "perf_schema_enabled":    perf_schema_enabled,
            "perf_consumers":         perf_consumers,
            "consumers_auto_enabled": consumers_enabled,
            "file_queries":           file_queries,
            "file_error":             file_error,
            "total":                  len(all_queries),
        }

    except Exception as e:
        raise HTTPException(500, f"MySQL error: {str(e)}")


# ── Slow-log file parser ─────────────────────────────────────────────────────

def _parse_slow_log_file(filepath, default_db):
    with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()

    queries = []
    for block in content.split("# Time:"):
        try:
            if "Query_time:" not in block:
                continue
            tm  = re.search(r"^(.*?)\n", block, re.MULTILINE)
            qt  = re.search(r"Query_time:\s*([\d.]+)", block)
            lt  = re.search(r"Lock_time:\s*([\d.]+)", block)
            re_ = re.search(r"Rows_examined:\s*(\d+)", block)
            rs  = re.search(r"Rows_sent:\s*(\d+)", block)
            sql = re.search(r"SET timestamp=.*?;\n(.*?;)", block, re.DOTALL)
            queries.append({
                "db_name":        default_db,
                "sql_text":       sql.group(1).strip() if sql else "",
                "avg_exec_sec":   float(qt.group(1)) if qt else 0.0,
                "max_exec_sec":   float(qt.group(1)) if qt else 0.0,
                "total_exec_sec": float(qt.group(1)) if qt else 0.0,
                "count_calls":    1,
                "rows_examined":  int(re_.group(1)) if re_ else 0,
                "rows_returned":  int(rs.group(1)) if rs else 0,
                "no_index_count": 0,
                "last_seen":      tm.group(1).strip() if tm else "",
            })
        except Exception:
            pass

    return queries[::-1]
