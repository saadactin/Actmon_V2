"""
PostgreSQL Query Plan Analysis — pg_hint_plan availability detection,
controlled EXPLAIN / EXPLAIN ANALYZE execution, hint validation, and
original-vs-hinted plan comparison.

Read-only by design: nothing here ever creates an index, alters a table, or
changes a PostgreSQL configuration parameter. A tested hint only ever
influences the ONE EXPLAIN this request runs (pg_hint_plan hints are a SQL
comment attached to a single statement) — it is never installed as a
permanent optimizer setting. Comparison results are logged for later review
(Plan History) but nothing here re-runs automatically; every execution is
one explicit user action.

Reuses the engine-resolution helpers (_pg_engine/_pg_engine_db) and the
plan-flattening/advisory-hints helpers (_flatten_plan/_pg_explain_hints)
already built for the existing Slow Queries "Explain" feature in
postgres_monitoring_service.py — this is a separate, explicitly-gated entry
point (the caller controls ANALYZE; there's no automatic try-first), not a
duplicate query-execution mechanism.
"""

import hashlib
import json
import re
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.models.postgres_plan_comparison_model import PostgresPlanComparison
from app.services.postgres.postgres_monitoring_service import (
    _pg_engine, _pg_engine_db, _flatten_plan, _pg_explain_hints,
)

DEFAULT_STATEMENT_TIMEOUT_MS = 10_000
MAX_STATEMENT_TIMEOUT_MS = 30_000
STATS_STALE_DAYS = 7

# EXPLAIN ANALYZE genuinely executes the statement — only allow it for
# statement forms that can't mutate data. Plain EXPLAIN (planner-only, never
# executes) has no such restriction.
_READONLY_LEADING_KEYWORDS = ("SELECT", "WITH", "TABLE", "VALUES")

# pg_hint_plan's documented hint names. An unrecognized name is a WARNING,
# not a hard block — pg_hint_plan is still allowed to see it (a newer
# extension version may support hints this list hasn't been updated for),
# it just isn't validated further.
KNOWN_HINTS = {
    "SeqScan", "NoSeqScan", "IndexScan", "NoIndexScan", "IndexOnlyScan", "NoIndexOnlyScan",
    "BitmapScan", "NoBitmapScan", "TidScan", "NoTidScan",
    "IndexScanRegexp", "IndexOnlyScanRegexp", "BitmapScanRegexp",
    "NestLoop", "NoNestLoop", "HashJoin", "NoHashJoin", "MergeJoin", "NoMergeJoin",
    "Leading", "Rows", "Parallel", "MemoRize", "NoMemoRize", "Set",
}
_INDEX_HINTS = {"IndexScan", "NoIndexScan", "IndexOnlyScan", "NoIndexOnlyScan", "BitmapScan", "NoBitmapScan"}

HINT_TEMPLATES = [
    {"name": "IndexScan", "example": "IndexScan(orders orders_customer_status_idx)",
     "description": "Force an index scan on a table, optionally naming which index."},
    {"name": "NoSeqScan", "example": "NoSeqScan(orders)",
     "description": "Forbid a sequential scan on a table — planner must pick another method."},
    {"name": "SeqScan", "example": "SeqScan(orders)", "description": "Force a sequential scan."},
    {"name": "BitmapScan", "example": "BitmapScan(orders orders_customer_status_idx)",
     "description": "Force a bitmap index scan."},
    {"name": "IndexOnlyScan", "example": "IndexOnlyScan(orders orders_customer_status_idx)",
     "description": "Force an index-only scan (requires a covering index)."},
    {"name": "NestLoop", "example": "NestLoop(orders customers)", "description": "Force a nested-loop join between two tables/aliases."},
    {"name": "HashJoin", "example": "HashJoin(orders customers)", "description": "Force a hash join."},
    {"name": "MergeJoin", "example": "MergeJoin(orders customers)", "description": "Force a merge join."},
    {"name": "Leading", "example": "Leading(orders customers)", "description": "Force the join order (left-to-right)."},
    {"name": "Rows", "example": "Rows(orders customers #500)", "description": "Override the planner's row-count estimate for a join."},
    {"name": "Parallel", "example": "Parallel(orders 4)", "description": "Request a specific number of parallel workers."},
]

_HINT_BLOCK_RE = re.compile(r"/\*\+(.*?)\*/", re.DOTALL)
_HINT_CALL_RE = re.compile(r"([A-Za-z]+)\s*\(([^)]*)\)")


def _get_pg_conn(conn_id: int, db: Session) -> ConnectionMaster:
    rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id, ConnectionMaster.db_type == "postgresql"
    ).first()
    if not rec:
        raise HTTPException(status_code=404, detail="PostgreSQL connection not found")
    return rec


def _engine_for(conn_rec: ConnectionMaster, database: str = None):
    return _pg_engine_db(conn_rec, database) if database else _pg_engine(conn_rec)


def _hash_query(sql: str) -> str:
    return hashlib.sha256(sql.strip().encode("utf-8")).hexdigest()


def _reject_dangerous_sql(sql_text: str, allow_analyze: bool):
    """Single-statement + statement-type guard. EXPLAIN has no bind-param
    form for the statement it explains (Postgres requires the literal SQL
    text), so this — not parameterization — is the injection defense: reject
    anything that looks like more than one statement before it ever reaches
    the database."""
    if not sql_text or not sql_text.strip():
        raise HTTPException(status_code=400, detail="No query text provided.")
    stripped = sql_text.strip().rstrip(";").strip()
    if ";" in stripped:
        raise HTTPException(status_code=400, detail="Only a single SQL statement is allowed — remove the extra ';'.")
    m = re.match(r"^\s*(\w+)", stripped)
    keyword = m.group(1).upper() if m else ""
    if allow_analyze and keyword not in _READONLY_LEADING_KEYWORDS:
        raise HTTPException(
            status_code=400,
            detail=f"EXPLAIN ANALYZE actually executes the statement — refusing for a '{keyword or 'unrecognized'}' "
                   "statement to avoid mutating data. Only SELECT/WITH/TABLE/VALUES can run with ANALYZE here; "
                   "use plain EXPLAIN to see the plan without executing it.",
        )
    return stripped, keyword


def _run_explain_sql(engine, sql_body: str, analyze: bool, timeout_ms: int) -> dict:
    opts = "ANALYZE, BUFFERS, FORMAT JSON" if analyze else "FORMAT JSON"
    with engine.connect() as conn:
        if analyze:
            conn.execute(text(f"SET LOCAL statement_timeout = '{int(timeout_ms)}ms'"))
        row = conn.execute(text(f"EXPLAIN ({opts}) {sql_body}")).fetchone()
        raw = row[0]
    if isinstance(raw, str):
        raw = json.loads(raw)
    top = raw[0] if isinstance(raw, list) else raw
    plan_node = top.get("Plan", top)
    planning_time = top.get("Planning Time")
    execution_time = top.get("Execution Time") if analyze else None
    nodes = _flatten_plan(plan_node)
    hints = _pg_explain_hints(nodes, planning_time or 0, execution_time or 0)
    return {
        "planning_time": planning_time, "execution_time": execution_time,
        "nodes": nodes, "hints": hints, "raw": raw,
    }


# ─────────────────────────────────────────────────────────────────────────
#  1. pg_hint_plan availability
# ─────────────────────────────────────────────────────────────────────────

def pg_hint_plan_availability(conn_id: int, db: Session) -> dict:
    conn_rec = _get_pg_conn(conn_id, db)
    try:
        engine = _pg_engine(conn_rec)
        with engine.connect() as c:
            pg_version = c.execute(text("SHOW server_version")).scalar()
            preload = c.execute(text("SHOW shared_preload_libraries")).scalar() or ""
            preloaded = "pg_hint_plan" in preload
            avail_row = c.execute(text(
                "SELECT default_version FROM pg_available_extensions WHERE name = 'pg_hint_plan'"
            )).first()
            ext_row = c.execute(text(
                "SELECT extversion FROM pg_extension WHERE extname = 'pg_hint_plan'"
            )).first()
    except Exception as exc:
        return {"status": "error", "error": str(exc)}

    available = avail_row is not None
    installed = ext_row is not None
    version = (ext_row[0] if ext_row else None) or (avail_row[0] if avail_row else None)
    can_use = installed and preloaded

    if can_use:
        message = f"pg_hint_plan {version or ''} is installed and active on this connection."
    elif installed and not preloaded:
        message = ("pg_hint_plan is installed in this database but is NOT in shared_preload_libraries — "
                   "hints will be silently ignored by the planner until an administrator adds "
                   "\"pg_hint_plan\" to shared_preload_libraries and restarts PostgreSQL.")
    elif available and not installed:
        message = ("pg_hint_plan is available on this server but not installed in this database — "
                   "an administrator can run CREATE EXTENSION pg_hint_plan; "
                   "(shared_preload_libraries must also include it — see above).")
    else:
        message = "pg_hint_plan is not installed or available on this PostgreSQL instance."

    return {
        "status": "success", "pg_version": pg_version,
        "available": available, "installed": installed, "preloaded": preloaded,
        "version": version, "can_use": can_use, "message": message,
    }


# ─────────────────────────────────────────────────────────────────────────
#  2. Hint parsing / validation
# ─────────────────────────────────────────────────────────────────────────

def _parse_hint_calls(hint_text: str):
    m = _HINT_BLOCK_RE.search(hint_text)
    inner = m.group(1) if m else hint_text
    return [{"name": cm.group(1), "args": cm.group(2).split()} for cm in _HINT_CALL_RE.finditer(inner)]


def validate_hint(conn_id: int, db: Session, hint_text: str, database: str = None) -> dict:
    """Real dictionary checks against pg_class/pg_index. A hint's first
    argument is often a query ALIAS, not the literal table name — we can't
    resolve an alias without a full SQL parser, so an unresolvable first arg
    is a soft warning, not a hard failure; an index name that's provably
    wrong for a table we DID resolve is a hard failure."""
    if not hint_text or not hint_text.strip():
        return {"ok": True, "warnings": [], "errors": [], "calls": []}

    calls = _parse_hint_calls(hint_text)
    if not calls:
        return {
            "ok": False, "warnings": [], "calls": [],
            "errors": ["No recognizable pg_hint_plan hint found — expected e.g. /*+ IndexScan(orders orders_pkey) */"],
        }

    conn_rec = _get_pg_conn(conn_id, db)
    engine = _engine_for(conn_rec, database)
    warnings, errors = [], []

    with engine.connect() as c:
        for call in calls:
            if call["name"] not in KNOWN_HINTS:
                warnings.append(f"'{call['name']}' isn't a hint name this validator recognizes — it will still be sent to pg_hint_plan as-is.")
                continue
            if not call["args"]:
                errors.append(f"{call['name']}() needs at least one argument (a table name or alias).")
                continue
            table_arg = call["args"][0]
            exists = c.execute(text(
                "SELECT 1 FROM pg_class WHERE relname = :n AND relkind IN ('r','p','m') LIMIT 1"
            ), {"n": table_arg}).first()
            if not exists:
                warnings.append(
                    f"'{table_arg}' isn't a real table name — if it's a query alias used with {call['name']}, "
                    "that's normal pg_hint_plan syntax; if it's meant to be the table itself, check the spelling."
                )
                continue
            if call["name"] in _INDEX_HINTS and len(call["args"]) > 1:
                for idx_name in call["args"][1:]:
                    idx_ok = c.execute(text(
                        "SELECT 1 FROM pg_index i "
                        "JOIN pg_class ic ON ic.oid = i.indexrelid "
                        "JOIN pg_class tc ON tc.oid = i.indrelid "
                        "WHERE tc.relname = :t AND ic.relname = :i LIMIT 1"
                    ), {"t": table_arg, "i": idx_name}).first()
                    if not idx_ok:
                        errors.append(f"Index \"{idx_name}\" does not exist on table \"{table_arg}\".")

    return {"ok": len(errors) == 0, "warnings": warnings, "errors": errors, "calls": calls}


# ─────────────────────────────────────────────────────────────────────────
#  3. Table/index statistics context (before recommending a hint)
# ─────────────────────────────────────────────────────────────────────────

def table_stats_for_hint(conn_id: int, db: Session, table_name: str, database: str = None) -> dict:
    conn_rec = _get_pg_conn(conn_id, db)
    engine = _engine_for(conn_rec, database)
    try:
        with engine.connect() as c:
            row = c.execute(text("""
                SELECT c.relname, c.reltuples,
                       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
                       s.last_analyze, s.last_autoanalyze, s.n_live_tup, s.n_dead_tup
                FROM pg_class c
                LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
                WHERE c.relname = :t AND c.relkind IN ('r', 'p')
            """), {"t": table_name}).mappings().first()
            if not row:
                return {"status": "error", "error": f"Table '{table_name}' not found."}
            idx_rows = c.execute(text("""
                SELECT ic.relname AS index_name, pg_get_indexdef(ix.indexrelid) AS definition,
                       s.idx_scan, pg_size_pretty(pg_relation_size(ix.indexrelid)) AS index_size
                FROM pg_index ix
                JOIN pg_class tc ON tc.oid = ix.indrelid
                JOIN pg_class ic ON ic.oid = ix.indexrelid
                LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = ix.indexrelid
                WHERE tc.relname = :t
            """), {"t": table_name}).mappings().all()
    except Exception as exc:
        return {"status": "error", "error": str(exc)}

    last_analyzed = row["last_analyze"] or row["last_autoanalyze"]
    stale = True
    if last_analyzed:
        ref = last_analyzed if last_analyzed.tzinfo else last_analyzed.replace(tzinfo=timezone.utc)
        stale = (datetime.now(timezone.utc) - ref).days > STATS_STALE_DAYS

    return {
        "status": "success", "table_name": row["relname"],
        "estimated_rows": row["reltuples"], "live_rows": row["n_live_tup"], "dead_rows": row["n_dead_tup"],
        "total_size": row["total_size"],
        "last_analyzed": last_analyzed.isoformat() if last_analyzed else None,
        "stats_stale": stale,
        "indexes": [dict(i) for i in idx_rows],
    }


# ─────────────────────────────────────────────────────────────────────────
#  4. Plan comparison — the core action
# ─────────────────────────────────────────────────────────────────────────

def _num(v):
    return float(v) if isinstance(v, Decimal) else v


def _row_to_dict(row: PostgresPlanComparison) -> dict:
    return {
        "id": row.id, "conn_id": row.conn_id, "database_name": row.database_name,
        "query_text": row.query_text, "query_hash": row.query_hash,
        "hint_text": row.hint_text, "analyzed": row.analyzed,
        "original_plan": row.original_plan, "hinted_plan": row.hinted_plan,
        "original_planning_ms": _num(row.original_planning_ms), "original_execution_ms": _num(row.original_execution_ms),
        "hinted_planning_ms": _num(row.hinted_planning_ms), "hinted_execution_ms": _num(row.hinted_execution_ms),
        "result": row.result, "warnings": row.warnings or [], "error_details": row.error_details,
        "requested_by": row.requested_by,
        "created_at": (row.created_at.isoformat() + "Z") if row.created_at else None,
    }


def run_plan_comparison(conn_id: int, db: Session, claims: dict, sql_text: str,
                        hint_text: str = None, analyze: bool = False,
                        database: str = None, timeout_ms: int = DEFAULT_STATEMENT_TIMEOUT_MS) -> dict:
    sql_body, _keyword = _reject_dangerous_sql(sql_text, allow_analyze=analyze)
    timeout_ms = min(max(int(timeout_ms or DEFAULT_STATEMENT_TIMEOUT_MS), 1000), MAX_STATEMENT_TIMEOUT_MS)

    conn_rec = _get_pg_conn(conn_id, db)

    hint_validation = {"ok": True, "warnings": [], "errors": []}
    has_hint = bool(hint_text and hint_text.strip())
    if has_hint:
        hint_validation = validate_hint(conn_id, db, hint_text, database)
        if not hint_validation["ok"]:
            raise HTTPException(status_code=400, detail={"message": "Hint validation failed", "errors": hint_validation["errors"]})

    engine = _engine_for(conn_rec, database)

    try:
        original = _run_explain_sql(engine, sql_body, analyze, timeout_ms)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"EXPLAIN failed for the original query: {exc}")

    hinted = None
    if has_hint:
        hinted_sql = f"{hint_text.strip()}\n{sql_body}"
        try:
            hinted = _run_explain_sql(engine, hinted_sql, analyze, timeout_ms)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"EXPLAIN failed for the hinted query: {exc}")

    result = None
    if hinted:
        if analyze and original.get("execution_time") is not None and hinted.get("execution_time") is not None:
            orig_t, hint_t = original["execution_time"], hinted["execution_time"]
            result = "improved" if hint_t < orig_t * 0.95 else "worse" if hint_t > orig_t * 1.05 else "same"
        else:
            # Estimated-only (no ANALYZE) — a lower planner cost is never
            # treated as a proven improvement, only actual execution time is.
            result = "unknown"

    row = PostgresPlanComparison(
        org_id=conn_rec.org_id or 1, conn_id=conn_id,
        database_name=database or conn_rec.database_name,
        query_text=sql_body, query_hash=_hash_query(sql_body),
        hint_text=hint_text if has_hint else None, analyzed=bool(analyze),
        original_plan=original, hinted_plan=hinted,
        original_planning_ms=original.get("planning_time"), original_execution_ms=original.get("execution_time"),
        hinted_planning_ms=(hinted or {}).get("planning_time"), hinted_execution_ms=(hinted or {}).get("execution_time"),
        result=result, warnings=hint_validation.get("warnings") or [],
        requested_by=claims.get("user_id"),
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    out = _row_to_dict(row)
    out["status"] = "success"
    out["hint_warnings"] = hint_validation.get("warnings") or []
    return out


# ─────────────────────────────────────────────────────────────────────────
#  5. Plan comparison history
# ─────────────────────────────────────────────────────────────────────────

def list_plan_comparisons(conn_id: int, db: Session, limit: int = 100) -> dict:
    limit = min(max(int(limit or 100), 1), 500)
    rows = (
        db.query(PostgresPlanComparison)
        .filter(PostgresPlanComparison.conn_id == conn_id)
        .order_by(PostgresPlanComparison.created_at.desc())
        .limit(limit)
        .all()
    )
    # Summary rows only — the full plan JSON is fetched on demand via
    # get_plan_comparison() so the history list itself stays light.
    return {
        "status": "success",
        "comparisons": [
            {
                "id": r.id, "database_name": r.database_name,
                "query_text": r.query_text[:300], "hint_text": r.hint_text,
                "analyzed": r.analyzed, "result": r.result,
                "original_execution_ms": _num(r.original_execution_ms),
                "hinted_execution_ms": _num(r.hinted_execution_ms),
                "created_at": (r.created_at.isoformat() + "Z") if r.created_at else None,
            }
            for r in rows
        ],
    }


def get_plan_comparison(comparison_id: int, db: Session) -> dict:
    row = db.query(PostgresPlanComparison).filter(PostgresPlanComparison.id == comparison_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Plan comparison not found")
    out = _row_to_dict(row)
    out["status"] = "success"
    return out
