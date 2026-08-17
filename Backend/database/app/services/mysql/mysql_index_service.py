from collections import defaultdict
from urllib.parse import quote_plus

from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster


def _mysql_engine(conn: ConnectionMaster):
    pw = quote_plus(conn.password or "")
    url = (
        f"mysql+pymysql://{conn.username}:{pw}"
        f"@{conn.host}:{conn.port}/{conn.database_name or ''}"
    )
    from app.services.common import db_proxy_service
    return db_proxy_service.engine_for(conn, lambda: create_engine(url, poolclass=NullPool))


def _rows(engine, sql: str, params=None) -> list:
    with engine.connect() as c:
        r = c.execute(text(sql), params or {})
        return [dict(row) for row in r.mappings().all()]


def _detect_duplicates(indexes_by_table: dict) -> list:
    duplicates = []
    for (db, table), idx_map in indexes_by_table.items():
        names = list(idx_map.keys())
        for i in range(len(names)):
            for j in range(len(names)):
                if i == j:
                    continue
                a_name, b_name = names[i], names[j]
                if a_name == "PRIMARY" or b_name == "PRIMARY":
                    continue
                a_cols = idx_map[a_name]
                b_cols = idx_map[b_name]
                if len(a_cols) < len(b_cols) and b_cols[: len(a_cols)] == a_cols:
                    duplicates.append({
                        "db_name":          db,
                        "table_name":       table,
                        "redundant_index":  a_name,
                        "covered_by":       b_name,
                        "columns":          a_cols,
                        "covered_columns":  b_cols,
                        "drop_statement":   f"ALTER TABLE `{db}`.`{table}` DROP INDEX `{a_name}`;",
                    })
    return duplicates


def get_index_analysis(conn_id: int, db: Session, live: bool = False) -> dict:
    from app.utils.agent_cache import get_snapshot as _get_snap
    if not live:
        cached = _get_snap(conn_id, "mysql_index_analysis", db)
        if cached is not None:
            return cached

    conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not conn:
        return {"status": "error", "message": "Connection not found"}

    try:
        engine = _mysql_engine(conn)
    except Exception as e:
        return {"status": "error", "message": f"Engine error: {e}"}

    perf_schema_enabled = False
    try:
        with engine.connect() as c:
            row = c.execute(text("SHOW VARIABLES LIKE 'performance_schema'")).fetchone()
            perf_schema_enabled = (row[1] if row else "OFF") == "ON"
    except Exception:
        pass

    result = {
        "status":                 "success",
        "perf_schema_enabled":    perf_schema_enabled,
        "existing_indexes":       [],
        "unused_indexes":         [],
        "duplicate_indexes":      [],
        "missing_index_candidates": [],
        "table_sizes":            [],
        "no_index_queries":       [],
        "summary":                {},
        "errors":                 {},
    }

    # 1. Existing Indexes
    tbl_indexes = defaultdict(lambda: defaultdict(list))
    try:
        rows = _rows(engine, """
            SELECT
                TABLE_SCHEMA   AS db_name,
                TABLE_NAME     AS table_name,
                INDEX_NAME     AS index_name,
                SEQ_IN_INDEX   AS seq,
                COLUMN_NAME    AS column_name,
                NON_UNIQUE     AS non_unique,
                INDEX_TYPE     AS index_type,
                NULLABLE       AS nullable,
                CARDINALITY    AS cardinality
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA NOT IN
                  ('performance_schema','information_schema','mysql','sys')
            ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
        """)

        idx_map = defaultdict(lambda: {
            "db_name": "", "table_name": "", "index_name": "",
            "index_type": "", "non_unique": 1, "columns": [], "cardinality": 0,
        })
        for r in rows:
            key = (r["db_name"], r["table_name"], r["index_name"])
            obj = idx_map[key]
            obj["db_name"]    = r["db_name"]
            obj["table_name"] = r["table_name"]
            obj["index_name"] = r["index_name"]
            obj["index_type"] = r["index_type"]
            obj["non_unique"] = int(r["non_unique"])
            obj["columns"].append(r["column_name"])
            obj["cardinality"] = r["cardinality"]
            tbl_indexes[(r["db_name"], r["table_name"])][r["index_name"]].append(r["column_name"])

        result["existing_indexes"] = list(idx_map.values())
        result["errors"]["existing_indexes"] = None
    except Exception as e:
        result["errors"]["existing_indexes"] = str(e)

    # 2. Unused Indexes (performance_schema)
    try:
        unused = _rows(engine, """
            SELECT
                OBJECT_SCHEMA  AS db_name,
                OBJECT_NAME    AS table_name,
                INDEX_NAME     AS index_name,
                COUNT_READ     AS count_read,
                COUNT_WRITE    AS count_write,
                COUNT_FETCH    AS count_fetch,
                COUNT_INSERT   AS count_insert,
                COUNT_UPDATE   AS count_update,
                COUNT_DELETE   AS count_delete
            FROM performance_schema.table_io_waits_summary_by_index_usage
            WHERE OBJECT_SCHEMA NOT IN
                  ('performance_schema','information_schema','mysql','sys')
              AND INDEX_NAME IS NOT NULL
              AND INDEX_NAME != 'PRIMARY'
              AND COUNT_READ  = 0
              AND COUNT_WRITE = 0
            ORDER BY OBJECT_SCHEMA, OBJECT_NAME
        """)
        col_lookup = {
            (o["db_name"], o["table_name"], o["index_name"]): o["columns"]
            for o in result["existing_indexes"]
        }
        for u in unused:
            key = (u["db_name"], u["table_name"], u["index_name"])
            u["columns"] = col_lookup.get(key, [])
            u["drop_statement"] = (
                f"ALTER TABLE `{u['db_name']}`.`{u['table_name']}` "
                f"DROP INDEX `{u['index_name']}`;"
            )
            u["estimated_size_savings"] = "Unknown — run SHOW INDEX STATUS"

        result["unused_indexes"] = unused
        result["errors"]["unused_indexes"] = None
    except Exception as e:
        result["errors"]["unused_indexes"] = str(e)

    # 3. Duplicate / Redundant Indexes
    try:
        result["duplicate_indexes"] = _detect_duplicates(tbl_indexes)
        result["errors"]["duplicate_indexes"] = None
    except Exception as e:
        result["errors"]["duplicate_indexes"] = str(e)

    # 4. Table Sizes
    try:
        result["table_sizes"] = _rows(engine, """
            SELECT
                TABLE_SCHEMA AS db_name,
                TABLE_NAME   AS table_name,
                TABLE_ROWS   AS row_estimate,
                ROUND((DATA_LENGTH  + INDEX_LENGTH) / 1048576, 2) AS total_mb,
                ROUND(DATA_LENGTH  / 1048576, 2) AS data_mb,
                ROUND(INDEX_LENGTH / 1048576, 2) AS index_mb,
                ENGINE
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA NOT IN
                  ('performance_schema','information_schema','mysql','sys')
              AND TABLE_TYPE = 'BASE TABLE'
            ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC
            LIMIT 200
        """)
        result["errors"]["table_sizes"] = None
    except Exception as e:
        result["errors"]["table_sizes"] = str(e)

    # 5 & 6. Full-Scan Queries + Missing Index Candidates — sourced from the
    # REAL Slow Query Log (never performance_schema). Each genuine application
    # query found there (already excludes system/session/ActMon-internal
    # traffic — see mysql_slow_query_service.is_actmon_internal_query) is run
    # through the SAME EXPLAIN + table/index-metadata + coverage-validation
    # pipeline the "Analyze Query" workspace uses for one query at a time, so
    # "full scan" and "missing index" here mean the execution plan actually
    # says so — never a digest counter, never a regex guess at table names.
    try:
        from app.services.mysql import mysql_slow_query_service as _sqs
        from app.services.mysql import mysql_slow_query_analysis_service as _analysis

        slow_resp = _sqs.get_slow_queries(conn_id, db, live=live)
        app_queries = slow_resp.get("file_queries") or []

        no_idx_queries = []
        # Aggregated per (db, table): every occurrence where the query's own
        # coverage check found no existing index covering its predicates.
        candidates_by_key = {}

        for q in app_queries[:40]:
            sql_text = q.get("sql_text")
            db_name = q.get("db_name")
            if not sql_text:
                continue
            try:
                explain_result = _analysis.explain_query(conn_id, sql_text, db_name, db, mode="estimate")
            except Exception:
                continue
            if explain_result.get("status") != "success":
                continue

            flags = explain_result.get("flags", {})
            table_names = _analysis.resolve_table_names(explain_result.get("tables", []), sql_text)
            meta = _analysis.collect_table_metadata(conn_id, table_names, db_name, db)
            tables_meta = meta.get("tables", [])
            coverage_findings, _predicates = _analysis.validate_index_coverage(sql_text, tables_meta)

            if flags.get("has_full_scan"):
                no_idx_queries.append({
                    "db_name": db_name,
                    "sql_text": sql_text,
                    "count_calls": q.get("count_calls", 1),
                    "avg_sec": q.get("avg_exec_sec", 0.0),
                    "max_sec": q.get("max_exec_sec", 0.0),
                    "no_index_used": 1 if flags.get("has_full_scan") else 0,
                    "no_good_index_used": 1 if flags.get("has_ignored_index") else 0,
                    "rows_examined": q.get("rows_examined", 0),
                    "rows_sent": q.get("rows_returned", 0),
                    "last_seen": q.get("last_seen"),
                })

            for f in coverage_findings:
                if f.get("verdict") != "not_covered":
                    continue
                key = (db_name, f["table_name"])
                agg = candidates_by_key.setdefault(key, {
                    "db_name": db_name, "table_name": f["table_name"],
                    "no_index_count": 0, "rows_examined": 0, "worst_avg_sec": 0.0,
                    "columns_needed": [],
                })
                agg["no_index_count"] += 1
                agg["rows_examined"] = max(agg["rows_examined"], int(q.get("rows_examined") or 0))
                agg["worst_avg_sec"] = max(agg["worst_avg_sec"], float(q.get("avg_exec_sec") or 0))
                for c in f.get("columns_needed", []):
                    if c not in agg["columns_needed"]:
                        agg["columns_needed"].append(c)

        result["no_index_queries"] = no_idx_queries
        result["errors"]["no_index_queries"] = None

        size_lookup = {(t["db_name"], t["table_name"]): t for t in result["table_sizes"]}
        existing_col_lookup = defaultdict(list)
        for idx in result["existing_indexes"]:
            existing_col_lookup[(idx["db_name"], idx["table_name"])].append(idx)

        candidates = []
        for (db_name, tbl), agg in sorted(candidates_by_key.items(), key=lambda x: -x[1]["no_index_count"]):
            size_info = size_lookup.get((db_name, tbl), {})
            existing = existing_col_lookup.get((db_name, tbl), [])
            cols = agg["columns_needed"]
            idx_name = f"idx_{tbl}_{'_'.join(cols)}"[:64] if cols else f"idx_{tbl}"
            suggested_sql = (
                f"CREATE INDEX `{idx_name}` ON `{db_name}`.`{tbl}` ({', '.join(f'`{c}`' for c in cols)});"
                if cols else f"-- No specific predicate columns could be extracted for `{tbl}`."
            )
            candidates.append({
                "db_name": db_name,
                "table_name": tbl,
                "no_index_count": agg["no_index_count"],
                "rows_examined": agg["rows_examined"],
                "worst_avg_sec": round(agg["worst_avg_sec"], 4),
                "table_rows": size_info.get("row_estimate"),
                "data_mb": size_info.get("data_mb"),
                "existing_indexes": [e["index_name"] for e in existing],
                "recommendation": (
                    f"Queries filtering/joining on {', '.join(cols)} have no existing index with that "
                    f"leading prefix on `{tbl}` — the optimizer has no efficient access path."
                    if cols else f"Add an index on the frequently filtered/joined columns of `{tbl}`."
                ),
                "suggested_sql": suggested_sql,
                "crud_impact": {
                    "select": "Significant improvement expected (full scan → index seek)",
                    "insert": "Minor overhead per insert for each new index",
                    "update": "Minor overhead for indexed column updates",
                    "delete": "Minimal overhead for delete operations",
                    "storage": "Additional disk space per index (typically 10-30% of data size)",
                },
            })

        result["missing_index_candidates"] = candidates[:30]
        result["errors"]["missing_index_candidates"] = None
    except Exception as e:
        result["errors"]["no_index_queries"] = result["errors"].get("no_index_queries") or str(e)
        result["errors"]["missing_index_candidates"] = result["errors"].get("missing_index_candidates") or str(e)

    # 7. Summary
    result["summary"] = {
        "total_indexes":          len(result["existing_indexes"]),
        "unused_count":           len(result["unused_indexes"]),
        "duplicate_count":        len(result["duplicate_indexes"]),
        "missing_candidates":     len(result["missing_index_candidates"]),
        "no_index_queries":       len(result["no_index_queries"]),
        "total_tables_analyzed":  len(result["table_sizes"]),
        "health_score": max(0, 100
            - len(result["unused_indexes"])    * 5
            - len(result["duplicate_indexes"]) * 3
            - min(len(result["missing_index_candidates"]) * 4, 40)
        ),
    }

    return result
