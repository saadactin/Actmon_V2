"""
Query-scoped execution-plan + table + index analysis for the Slow Query
"Analyze Query" workspace.

Deliberately separate from `mysql_slow_query_service.py` (owns collection/
listing of slow queries) and `mysql_index_service.py` (owns the whole-
database Index Analysis page) — this module answers one narrower question:
for THIS ONE query, what do its execution plan, its actual tables, and their
actual existing indexes say? Every finding here is grounded in real
information_schema/EXPLAIN data — nothing is invented, and this module never
recommends an index without first checking whether one already covers the
same columns (see `validate_index_coverage`).

Read-only, always. `explain_query()`'s `mode="analyze"` (EXPLAIN ANALYZE,
which actually EXECUTES the statement) is only ever honored for a provable
SELECT/CTE — see `_is_safe_to_execute` — and silently falls back to the safe
estimated plan otherwise, with the reason reported back to the caller.
"""
import json
import re
from collections import defaultdict
from urllib.parse import quote_plus

from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.services.common import db_proxy_service
from app.services.mysql.mysql_index_service import _detect_duplicates


def _mysql_url(conn: ConnectionMaster, db_name: str = None) -> str:
    pw = quote_plus(conn.password or "")
    return f"mysql+pymysql://{conn.username}:{pw}@{conn.host}:{conn.port}/{db_name or conn.database_name or ''}"


def _engine_for(conn: ConnectionMaster, db_name: str = None):
    return db_proxy_service.engine_for(
        conn, lambda: create_engine(_mysql_url(conn, db_name), connect_args={"connect_timeout": 5}, poolclass=NullPool)
    )


def _rows(engine, sql: str) -> list:
    with engine.connect() as c:
        return [dict(r) for r in c.execute(text(sql)).mappings().all()]


def _safe_ident(name: str) -> str:
    """Strips anything that isn't a valid unquoted MySQL identifier character.
    Used only on table names WE already extracted from EXPLAIN's own JSON
    output (never raw user input) before inlining them into an IN(...) list —
    information_schema queries can't parametrize a variable-length IN list
    cleanly via SQLAlchemy `text()`, so this is the safety net instead."""
    return re.sub(r"[^A-Za-z0-9_$]", "", name or "")


# ── Production safety ─────────────────────────────────────────────────────────

_UNSAFE_VERB_RE = re.compile(
    r"\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CALL|LOCK|UNLOCK|SET\s+GLOBAL)\b",
    re.IGNORECASE,
)

# Statement shapes MySQL's plain (non-ANALYZE) EXPLAIN actually supports —
# SELECT/WITH never execute under EXPLAIN, and INSERT/UPDATE/DELETE/REPLACE
# have been explainable-without-executing since MySQL 8.0.19. CALL, DDL, and
# anything else are rejected before ever reaching the server.
_EXPLAIN_SUPPORTED_RE = re.compile(
    r"^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE)\b", re.IGNORECASE
)


def _is_safe_to_execute(sql_text: str) -> tuple:
    """EXPLAIN ANALYZE actually RUNS the statement — this must never be true
    for anything but a plain read. Returns (safe: bool, reason: str)."""
    s = (sql_text or "").strip().rstrip(";")
    if not s:
        return False, "Empty statement."
    if _UNSAFE_VERB_RE.search(s):
        return False, "Statement contains a data/schema-changing verb — EXPLAIN ANALYZE would execute it for real."
    if not re.match(r"^\s*(WITH\b|SELECT\b)", s, re.IGNORECASE):
        return False, "Only SELECT (optionally with a leading WITH/CTE) may run under EXPLAIN ANALYZE."
    return True, ""


# ── EXPLAIN FORMAT=JSON parsing ────────────────────────────────────────────

def _walk_plan(node, tables: list, flags: dict) -> None:
    """MySQL's EXPLAIN FORMAT=JSON tree has no fixed schema — a "table" object
    can appear at query_block level, inside nested_loop[], inside a
    grouping_operation/ordering_operation/duplicates_removal wrapper, inside a
    materialized subquery, etc. Rather than hard-code every shape this walks
    the whole tree once, collecting every "table" dict found anywhere plus the
    operation-level flags that only exist as wrapper keys (not inside "table"
    itself)."""
    if isinstance(node, dict):
        if node.get("using_temporary_table"):
            flags["has_temp_table"] = True
        if node.get("using_filesort"):
            flags["has_filesort"] = True
        if "duplicates_removal" in node:
            flags["has_dedup"] = True
        t = node.get("table")
        if isinstance(t, dict):
            tables.append({
                "table_name": t.get("table_name"),
                "access_type": t.get("access_type"),
                "possible_keys": t.get("possible_keys") or [],
                "key": t.get("key"),
                "used_key_parts": t.get("used_key_parts") or [],
                "key_length": t.get("key_length"),
                "ref": t.get("ref"),
                "rows_examined_per_scan": t.get("rows_examined_per_scan"),
                "rows_produced_per_join": t.get("rows_produced_per_join"),
                "filtered": t.get("filtered"),
                "using_index": bool(t.get("using_index")),
                "using_index_condition": bool(t.get("using_index_condition")),
                "using_where": bool(t.get("attached_condition")),
                "using_join_buffer": t.get("using_join_buffer"),
                "materialized": "materialized_from_subquery" in t,
            })
            if t.get("access_type") == "ALL":
                flags["has_full_scan"] = True
            if t.get("access_type") == "index":
                flags["has_full_index_scan"] = True
            if t.get("possible_keys") and not t.get("key"):
                flags["has_ignored_index"] = True
        for k, v in node.items():
            if k == "table":
                continue
            _walk_plan(v, tables, flags)
    elif isinstance(node, list):
        for item in node:
            _walk_plan(item, tables, flags)


def explain_query(conn_id: int, sql_text: str, db_name: str, db: Session, mode: str = "estimate") -> dict:
    """Runs `EXPLAIN FORMAT=JSON` by default (`mode="estimate"` — safe, never
    executes the query). `mode="analyze"` runs `EXPLAIN ANALYZE` instead
    (which DOES execute the statement) and is only honored when
    `_is_safe_to_execute` passes — otherwise this silently falls back to the
    safe estimated plan and reports why in `analyze_declined_reason`, rather
    than either refusing outright or running it anyway.

    Plain (non-ANALYZE) `EXPLAIN` never executes SELECT/WITH, and MySQL 8.0.19+
    also supports it for INSERT/UPDATE/DELETE/REPLACE without running them —
    all five are genuinely safe to attempt. CALL, DDL, and anything else
    EXPLAIN doesn't support at all is rejected up front with a clear reason,
    rather than surfacing MySQL's own syntax-error text for an attempt that
    was never going to work."""
    if not _EXPLAIN_SUPPORTED_RE.match(sql_text or ""):
        return {
            "status": "error",
            "error": (
                "Execution-plan analysis isn't available for this statement type. "
                "EXPLAIN only supports SELECT/WITH/INSERT/UPDATE/DELETE/REPLACE — "
                "this query is not run here."
            ),
        }

    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": "Connection not found"}

    resolved_db = db_name or rec.database_name or ""
    engine = _engine_for(rec, resolved_db)

    requested_analyze = (mode == "analyze")
    safe, unsafe_reason = _is_safe_to_execute(sql_text) if requested_analyze else (False, "")
    ran_analyze = requested_analyze and safe

    stmt = f"EXPLAIN {'ANALYZE ' if ran_analyze else ''}FORMAT=JSON {sql_text.rstrip(';')}"

    try:
        with engine.connect() as conn:
            if resolved_db:
                try:
                    conn.execute(text(f"USE `{resolved_db}`"))
                except Exception:
                    pass
            row = conn.execute(text(stmt)).fetchone()
            raw_json = row[0] if row else None
    except Exception as e:
        if ran_analyze:
            # EXPLAIN ANALYZE FORMAT=JSON isn't universally available (older
            # MySQL/MariaDB) — fall back to the safe estimated plan rather
            # than surfacing a bare SQL error for a mode the caller can't
            # control the server version of.
            return explain_query(conn_id, sql_text, db_name, db, mode="estimate")
        return {"status": "error", "error": str(e)}

    try:
        parsed = json.loads(raw_json) if isinstance(raw_json, str) else (raw_json or {})
    except Exception as e:
        return {"status": "error", "error": f"Could not parse EXPLAIN output: {e}"}

    tables, flags = [], {}
    _walk_plan(parsed, tables, flags)

    return {
        "status": "success",
        "mode": "analyze" if ran_analyze else "estimate",
        "requested_mode": mode,
        "analyze_declined_reason": unsafe_reason if (requested_analyze and not safe) else None,
        "raw_plan": parsed,
        "tables": tables,
        "flags": flags,
    }


# ── Alias resolution ───────────────────────────────────────────────────────────
#
# MySQL's EXPLAIN FORMAT=JSON reports a table's QUERY ALIAS as `table_name`
# when the query used one ("FROM customer c" → JSON table_name is "c", not
# "customer") — there is no separate "real table" field once an alias is
# given. Looking up information_schema by that alias finds nothing. This
# recovers the real table name by parsing the query's own FROM/JOIN clauses.

_SQL_KEYWORDS_AFTER_TABLE = {
    "where", "on", "join", "left", "right", "inner", "outer", "group", "order",
    "limit", "having", "union", "set", "as", "using", "cross", "natural", "for",
}
_FROM_JOIN_ALIAS_RE = re.compile(
    r"\b(?:FROM|JOIN)\s+`?([A-Za-z_][\w]*)`?"
    r"(?:\s*\.\s*`?([A-Za-z_][\w]*)`?)?"
    r"(?:\s+(?:AS\s+)?`?([A-Za-z_][\w]*)`?)?",
    re.IGNORECASE,
)


def _extract_table_aliases(sql_text: str) -> dict:
    """Best-effort map of {alias_or_table_name_lowercased: real_table_name} —
    same regex-heuristic caveat as `_extract_predicate_columns` below: this is
    not a full SQL parser, it only recovers names to resolve EXPLAIN's alias
    reporting, never used as a source of truth about the query's semantics."""
    aliases = {}
    for m in _FROM_JOIN_ALIAS_RE.finditer(sql_text or ""):
        first, schema_qualified, alias = m.group(1), m.group(2), m.group(3)
        table = schema_qualified if schema_qualified else first
        if alias and alias.lower() in _SQL_KEYWORDS_AFTER_TABLE:
            alias = None
        aliases[table.lower()] = table
        if alias:
            aliases[alias.lower()] = table
    return aliases


def resolve_table_names(explain_tables: list, sql_text: str) -> list:
    """Translates each EXPLAIN table (possibly an alias) back to its real
    table name using `_extract_table_aliases`, falling back to the EXPLAIN
    value itself if it isn't a recognized alias (e.g. no alias was used)."""
    alias_map = _extract_table_aliases(sql_text)
    resolved = []
    for t in explain_tables:
        name = t.get("table_name")
        if not name:
            continue
        resolved.append(alias_map.get(name.lower(), name))
    return resolved


# ── Table + index metadata, scoped to the query's own tables ─────────────────

def collect_table_metadata(conn_id: int, table_names: list, db_name: str, db: Session) -> dict:
    """Per-table metadata for exactly the tables one query touched — schema,
    approx rows, size, engine, primary key, columns, and every existing
    index with its real column order/uniqueness/cardinality. Scoped (not the
    whole database, unlike mysql_index_service's page-wide scan) so this is
    cheap enough to run every time a query is opened, not just on a schedule."""
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": "Connection not found", "tables": [], "duplicate_indexes": []}

    names = sorted({_safe_ident(t) for t in table_names if t})
    names = [n for n in names if n]
    if not names:
        return {"status": "success", "tables": [], "duplicate_indexes": []}

    engine = _engine_for(rec, db_name)
    schema = _safe_ident(db_name or rec.database_name or "")
    name_list = ",".join(f"'{n}'" for n in names)
    schema_clause = f"AND TABLE_SCHEMA = '{schema}'" if schema else ""

    try:
        size_rows = _rows(engine, f"""
            SELECT TABLE_SCHEMA db_name, TABLE_NAME table_name, ENGINE engine,
                   TABLE_ROWS row_estimate,
                   ROUND(DATA_LENGTH/1048576, 2)  data_mb,
                   ROUND(INDEX_LENGTH/1048576, 2) index_mb,
                   ROUND((DATA_LENGTH+INDEX_LENGTH)/1048576, 2) total_mb
            FROM information_schema.TABLES
            WHERE TABLE_NAME IN ({name_list}) {schema_clause}
        """)
    except Exception:
        size_rows = []
    size_lookup = {(r["db_name"], r["table_name"]): r for r in size_rows}

    try:
        col_rows = _rows(engine, f"""
            SELECT TABLE_SCHEMA db_name, TABLE_NAME table_name, COLUMN_NAME column_name,
                   COLUMN_TYPE column_type, IS_NULLABLE is_nullable, COLUMN_KEY column_key,
                   ORDINAL_POSITION ordinal_position
            FROM information_schema.COLUMNS
            WHERE TABLE_NAME IN ({name_list}) {schema_clause}
            ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
        """)
    except Exception:
        col_rows = []
    cols_by_table, pk_by_table = defaultdict(list), defaultdict(list)
    for r in col_rows:
        key = (r["db_name"], r["table_name"])
        cols_by_table[key].append({"name": r["column_name"], "type": r["column_type"], "nullable": r["is_nullable"] == "YES"})
        if r["column_key"] == "PRI":
            pk_by_table[key].append(r["column_name"])

    try:
        idx_rows = _rows(engine, f"""
            SELECT TABLE_SCHEMA db_name, TABLE_NAME table_name, INDEX_NAME index_name,
                   SEQ_IN_INDEX seq, COLUMN_NAME column_name, NON_UNIQUE non_unique, CARDINALITY cardinality
            FROM information_schema.STATISTICS
            WHERE TABLE_NAME IN ({name_list}) {schema_clause}
            ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
        """)
    except Exception:
        idx_rows = []

    raw_index_cols = defaultdict(lambda: defaultdict(list))   # (schema,table) -> index_name -> [cols], for _detect_duplicates
    idx_meta = defaultdict(lambda: {"index_name": "", "unique": True, "primary": False, "columns": [], "cardinality": None})
    for r in idx_rows:
        key = (r["db_name"], r["table_name"])
        obj = idx_meta[(key, r["index_name"])]
        obj["index_name"] = r["index_name"]
        obj["unique"] = int(r["non_unique"]) == 0
        obj["primary"] = r["index_name"] == "PRIMARY"
        obj["columns"].append(r["column_name"])
        obj["cardinality"] = r["cardinality"]
        raw_index_cols[key][r["index_name"]].append(r["column_name"])

    indexes_by_table = defaultdict(list)
    for (key, _idx_name), obj in idx_meta.items():
        indexes_by_table[key].append(obj)

    all_keys = set(size_lookup) | set(cols_by_table) | set(indexes_by_table)
    tables_out = []
    for key in sorted(all_keys):
        db_n, tbl_n = key
        size_info = size_lookup.get(key, {})
        tables_out.append({
            "database_name": db_n, "table_name": tbl_n,
            "engine": size_info.get("engine"),
            "row_estimate": size_info.get("row_estimate"),
            "data_mb": size_info.get("data_mb"), "index_mb": size_info.get("index_mb"), "total_mb": size_info.get("total_mb"),
            "primary_key": pk_by_table.get(key, []),
            "columns": cols_by_table.get(key, []),
            "indexes": indexes_by_table.get(key, []),
        })

    # Prefix-based duplicate/redundant detection — reused as-is from
    # mysql_index_service.py (already correct), just scoped to this query's
    # own tables rather than the whole database.
    duplicate_indexes = _detect_duplicates(raw_index_cols)

    return {"status": "success", "tables": tables_out, "duplicate_indexes": duplicate_indexes}


# ── Query-vs-index coverage validation ────────────────────────────────────────

_WHERE_CLAUSE_RE = re.compile(r"\bWHERE\b(.+?)(?:\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|$)", re.IGNORECASE | re.DOTALL)
_WHERE_COL_RE = re.compile(r"\b([A-Za-z_][A-Za-z0-9_.]*)\s*(?:=|<=|>=|<>|!=|<|>|\bIN\s*\(|\bLIKE\b|\bBETWEEN\b|\bIS\b)", re.IGNORECASE)
_JOIN_ON_RE = re.compile(r"\bON\b\s+([A-Za-z_][\w.]*)\s*=\s*([A-Za-z_][\w.]*)", re.IGNORECASE)
_ORDER_BY_RE = re.compile(r"\bORDER\s+BY\s+(.+?)(?:\bLIMIT\b|$)", re.IGNORECASE | re.DOTALL)
_GROUP_BY_RE = re.compile(r"\bGROUP\s+BY\s+(.+?)(?:\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|$)", re.IGNORECASE | re.DOTALL)
_LEADING_WILDCARD_RE = re.compile(r"LIKE\s+'%", re.IGNORECASE)
_FUNC_WRAPPED_RE = re.compile(
    r"\b(?:YEAR|MONTH|DAY|DATE|UPPER|LOWER|SUBSTR(?:ING)?|CONCAT|CAST|CONVERT)\s*\(\s*[A-Za-z_][\w.]*\s*\)\s*(?:=|<|>|<=|>=)",
    re.IGNORECASE,
)
_SELECT_STAR_RE = re.compile(r"^\s*SELECT\s+\*", re.IGNORECASE)


def _extract_predicate_columns(sql_text: str) -> dict:
    """Best-effort, REGEX-based extraction of the columns a query filters,
    joins, sorts, and groups on — this is explicitly NOT a full SQL parser,
    and is never treated as a source of truth by itself. It only decides
    WHICH columns to look up against the database's real index metadata in
    `validate_index_coverage` — every verdict that function produces is
    grounded in that real metadata, never in this extraction alone."""
    s = sql_text or ""
    where_m = _WHERE_CLAUSE_RE.search(s)
    where_cols = [c.split(".")[-1] for c in _WHERE_COL_RE.findall(where_m.group(1))] if where_m else []

    join_cols = []
    for a, b in _JOIN_ON_RE.findall(s):
        join_cols.append(a.split(".")[-1])
        join_cols.append(b.split(".")[-1])

    order_m = _ORDER_BY_RE.search(s)
    order_cols = [c.strip().split(".")[-1].split()[0] for c in order_m.group(1).split(",") if c.strip()] if order_m else []

    group_m = _GROUP_BY_RE.search(s)
    group_cols = [c.strip().split(".")[-1] for c in group_m.group(1).split(",") if c.strip()] if group_m else []

    return {
        "where_columns": sorted(set(filter(None, where_cols))),
        "join_columns": sorted(set(filter(None, join_cols))),
        "order_by_columns": [c for c in order_cols if c],
        "group_by_columns": [c for c in group_cols if c],
        "leading_wildcard": bool(_LEADING_WILDCARD_RE.search(s)),
        "function_wrapped_predicate": bool(_FUNC_WRAPPED_RE.search(s)),
        "select_star": bool(_SELECT_STAR_RE.match(s)),
    }


def validate_index_coverage(sql_text: str, tables_meta: list) -> tuple:
    """For each table the query touches, compares its predicate/join/order
    columns (heuristically extracted above) against that table's REAL index
    definitions, and reports whether an existing index's LEADING columns
    already cover them — the "don't recommend an index that already exists"
    check §9 of the spec requires. Returns (findings: list, predicates: dict)."""
    predicates = _extract_predicate_columns(sql_text)
    query_cols = set(predicates["where_columns"]) | set(predicates["join_columns"])

    findings = []
    for t in tables_meta:
        table_cols = {c["name"] for c in t.get("columns", [])}
        relevant = sorted(query_cols & table_cols)

        if relevant:
            best_covering = None
            for idx in t.get("indexes", []):
                idx_cols = idx["columns"]
                leading = idx_cols[:len(relevant)]
                if set(leading) >= set(relevant) and (best_covering is None or len(idx_cols) < len(best_covering["columns"])):
                    best_covering = idx
            if best_covering:
                findings.append({
                    "table_name": t["table_name"], "columns_needed": relevant, "verdict": "covered",
                    "covering_index": best_covering["index_name"],
                    "explanation": (
                        f"An index on ({', '.join(best_covering['columns'])}) (`{best_covering['index_name']}`) "
                        f"already exists on `{t['table_name']}` and covers {', '.join(relevant)}. Adding another "
                        f"single/partial index on just {', '.join(relevant)} would likely be redundant."
                    ),
                })
            else:
                findings.append({
                    "table_name": t["table_name"], "columns_needed": relevant, "verdict": "not_covered",
                    "covering_index": None,
                    "explanation": (
                        f"No existing index on `{t['table_name']}` has a leading column set matching "
                        f"{', '.join(relevant)} — the optimizer has no efficient access path for this predicate."
                    ),
                })

        if predicates["order_by_columns"]:
            wanted = predicates["order_by_columns"]
            order_covered = any(idx["columns"][:len(wanted)] == wanted for idx in t.get("indexes", []))
            if not order_covered and set(wanted) & table_cols:
                findings.append({
                    "table_name": t["table_name"], "columns_needed": wanted, "verdict": "not_covered",
                    "covering_index": None,
                    "explanation": (
                        f"ORDER BY {', '.join(wanted)} has no matching index prefix on `{t['table_name']}` — "
                        "expect a filesort unless one is added."
                    ),
                })

    return findings, predicates


# ── Deterministic diagnosis ────────────────────────────────────────────────────

_SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def diagnose(explain_result: dict, coverage_findings: list, predicates: dict, metrics: dict) -> dict:
    """Every issue here is backed by a real signal — an EXPLAIN JSON flag, a
    metadata fact, or a metric ratio — never a guess. Nothing is flagged
    merely because it exists (e.g. an index scan is only flagged when the
    plan actually says access_type=index, not whenever an index is present).
    `metrics` = {rows_examined, rows_returned, count_calls, avg_exec_ms, total_exec_ms}."""
    issues = []
    flags = explain_result.get("flags", {})
    tables = explain_result.get("tables", [])

    for t in tables:
        tname = t.get("table_name")
        if t.get("access_type") == "ALL":
            issues.append({
                "type": "FULL_TABLE_SCAN", "severity": "critical", "table": tname,
                "evidence": f"access_type=ALL, rows_examined_per_scan={t.get('rows_examined_per_scan')}",
                "description": f"`{tname}` is fully scanned — every row is read for this query.",
            })
        elif t.get("access_type") == "index":
            issues.append({
                "type": "FULL_INDEX_SCAN", "severity": "high", "table": tname,
                "evidence": f"access_type=index, key={t.get('key')}",
                "description": f"`{tname}` scans the entire index `{t.get('key')}` rather than seeking into it.",
            })
        if t.get("possible_keys") and not t.get("key"):
            issues.append({
                "type": "UNUSED_AVAILABLE_INDEX", "severity": "high", "table": tname,
                "evidence": f"possible_keys={t.get('possible_keys')} but key=null",
                "description": f"`{tname}` has candidate indexes the optimizer chose not to use.",
            })
        try:
            filtered = float(t.get("filtered")) if t.get("filtered") is not None else None
        except (TypeError, ValueError):
            filtered = None
        if filtered is not None and filtered < 20 and t.get("access_type") not in (None, "const", "eq_ref"):
            issues.append({
                "type": "POOR_SELECTIVITY", "severity": "medium", "table": tname,
                "evidence": f"filtered={filtered}%",
                "description": f"Only ~{filtered}% of rows read from `{tname}` actually match — low selectivity for the access path chosen.",
            })

    if flags.get("has_filesort"):
        issues.append({"type": "FILESORT", "severity": "medium", "table": None,
                        "evidence": "using_filesort=true in the execution plan",
                        "description": "The result is sorted after retrieval — no index covers the ORDER BY."})
    if flags.get("has_temp_table"):
        issues.append({"type": "TEMP_TABLE", "severity": "medium", "table": None,
                        "evidence": "using_temporary_table=true in the execution plan",
                        "description": "MySQL builds a temporary table for GROUP BY/DISTINCT/UNION — extra memory/disk I/O."})

    rows_examined = metrics.get("rows_examined") or 0
    rows_returned = metrics.get("rows_returned") or 0
    if rows_examined > 1000 and rows_returned > 0:
        ratio = rows_examined / max(rows_returned, 1)
        if ratio > 100:
            issues.append({
                "type": "HIGH_EXAMINED_TO_RETURNED_RATIO", "severity": "high", "table": None,
                "evidence": f"rows_examined={rows_examined:,}, rows_returned={rows_returned:,} ({ratio:.0f}x)",
                "description": f"MySQL examined {ratio:.0f}x more rows than it returned — the access path is far less selective than the result set.",
            })
    elif rows_examined > 1000 and rows_returned == 0:
        issues.append({
            "type": "HIGH_EXAMINED_TO_RETURNED_RATIO", "severity": "medium", "table": None,
            "evidence": f"rows_examined={rows_examined:,}, rows_returned=0",
            "description": "Rows were scanned but none matched — the predicate may be more selective than any available index.",
        })

    if predicates.get("leading_wildcard"):
        issues.append({
            "type": "LEADING_WILDCARD", "severity": "high", "table": None,
            "evidence": "LIKE '%...' pattern found in the query text",
            "description": "A leading-wildcard LIKE cannot use a standard B-tree index prefix — MySQL must scan.",
        })
    if predicates.get("function_wrapped_predicate"):
        issues.append({
            "type": "NON_SARGABLE_PREDICATE", "severity": "high", "table": None,
            "evidence": "A function is applied directly to a column in a comparison (e.g. YEAR(col) = ...)",
            "description": "Wrapping an indexed column in a function prevents the optimizer from using any index on it.",
        })
    if predicates.get("select_star"):
        issues.append({
            "type": "SELECT_STAR", "severity": "low", "table": None,
            "evidence": "SELECT * found in the query text",
            "description": "Selecting every column can prevent a covering index and pulls more data than the application may actually need.",
        })

    for f in coverage_findings:
        if f["verdict"] == "not_covered":
            issues.append({
                "type": "MISSING_INDEX_CANDIDATE", "severity": "high", "table": f["table_name"],
                "evidence": f"Query filters/joins/sorts on {', '.join(f['columns_needed'])}; no existing index has that leading prefix.",
                "description": f["explanation"],
            })

    count_calls = metrics.get("count_calls") or 0
    avg_ms = metrics.get("avg_exec_ms") or 0
    if count_calls > 100 and avg_ms > 500:
        issues.append({
            "type": "REPEATED_EXPENSIVE_EXECUTION", "severity": "critical", "table": None,
            "evidence": f"Executed {count_calls:,} times averaging {avg_ms:.0f}ms — {(metrics.get('total_exec_ms') or 0) / 1000:.1f}s cumulative.",
            "description": "This isn't a one-off slow query — it runs often enough that the cumulative cost is high even if any single run seems tolerable.",
        })

    issues.sort(key=lambda i: _SEVERITY_RANK.get(i["severity"], 9))
    return {"issues": issues, "issue_count": len(issues)}


# ── Orchestration ──────────────────────────────────────────────────────────────

def analyze_query_full(conn_id: int, sql_text: str, db_name: str, metrics: dict, db: Session, mode: str = "estimate") -> dict:
    """The fast, deterministic half of the analysis workspace — EXPLAIN, table
    metadata, index coverage, and rule-based diagnosis. No Groq call (see
    `mysql_slow_query_service.analyze_slow_query_with_context` for that) —
    this is what runs the moment a user opens a query, so it needs to stay
    quick."""
    explain_result = explain_query(conn_id, sql_text, db_name, db, mode=mode)
    if explain_result.get("status") != "success":
        return explain_result

    table_names = resolve_table_names(explain_result.get("tables", []), sql_text)
    meta = collect_table_metadata(conn_id, table_names, db_name, db)
    tables_meta = meta.get("tables", [])

    coverage_findings, predicates = validate_index_coverage(sql_text, tables_meta)
    diagnosis = diagnose(explain_result, coverage_findings, predicates, metrics or {})

    return {
        "status": "success",
        "explain": explain_result,
        "tables": tables_meta,
        "duplicate_indexes": meta.get("duplicate_indexes", []),
        "index_coverage": coverage_findings,
        "predicates": predicates,
        "diagnosis": diagnosis,
    }
