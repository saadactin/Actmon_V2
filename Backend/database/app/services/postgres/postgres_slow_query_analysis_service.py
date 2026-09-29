"""PostgreSQL query-analysis workspace — the deterministic half.

Same shape as `mysql_slow_query_analysis_service.py`: one EXPLAIN, the query's
OWN tables' real catalogue metadata, a query-vs-index coverage check, and a
rule-based diagnosis. Everything it reports is evidence from the server; no
number here is invented, and nothing runs that the user did not ask for.

Two things differ from MySQL and drive the design:

1. PostgreSQL's plain `EXPLAIN` never executes the statement — not even for
   INSERT/UPDATE/DELETE. Only `EXPLAIN ANALYZE` does. So plain EXPLAIN is the
   default for every statement shape, and ANALYZE is a separate, explicitly
   confirmed action that is additionally refused for anything that writes.

2. A PostgreSQL plan names its relations directly ("Relation Name"), so none of
   MySQL's alias-resolution guesswork is needed. The SQL-text predicate
   extraction *is* engine-neutral, so it is imported from the MySQL module
   rather than copied — one parser, one set of bugs.
"""

import json
import logging
import re
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.services.postgres.postgres_monitoring_service import (
    _pg_engine, _pg_engine_db, _flatten_plan,
)
# Pure SQL-text parsing — no MySQL dialect assumptions in either of these.
from app.services.mysql.mysql_slow_query_analysis_service import (
    _extract_predicate_columns,
)

log = logging.getLogger("pg_query_analysis")

# A plan node's row count above which a sequential scan stops being "the
# planner correctly chose to read a small table" and starts being a finding.
_SEQ_SCAN_ROW_FLOOR = 1_000
# Tables below this many live rows are too small for index advice to be honest.
_SMALL_TABLE_ROWS = 500
# Statement timeout for every statement this module issues.
_STATEMENT_TIMEOUT = "10s"


# ═════════════════════════════════════════════════════════════════════════════
#  Safety
# ═════════════════════════════════════════════════════════════════════════════

# EXPLAIN ANALYZE genuinely runs the statement. For a write that means the
# write happens. This is the gate for that, and it is deliberately a
# whitelist: anything not provably a read is refused.
_WRITE_VERB_RE = re.compile(
    r"\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|DROP|ALTER|GRANT|REVOKE|"
    r"REFRESH|VACUUM|ANALYZE|CLUSTER|REINDEX|COPY|CALL|DO|LOCK|SET)\b",
    re.IGNORECASE,
)
_READ_START_RE = re.compile(r"^\s*(WITH\b|SELECT\b|TABLE\b|VALUES\b)", re.IGNORECASE)

# Plain EXPLAIN handles these; anything else (DDL, utility commands) cannot be
# explained at all and is rejected before it reaches the server.
_EXPLAINABLE_RE = re.compile(
    r"^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|MERGE|VALUES|TABLE|DECLARE|EXECUTE|CREATE\s+TABLE\s+AS|CREATE\s+MATERIALIZED\s+VIEW)\b",
    re.IGNORECASE,
)


_SQL_LITERAL_RE = re.compile(r"'(?:[^']|'')*'")


def _blank_literals(sql: str) -> str:
    """Replace every single-quoted literal with an empty one.

    Dollar-quoted bodies ($$…$$) are left alone deliberately: they can contain
    a whole procedure, and a statement carrying one is not something this gate
    should be trying to reason about — leaving the text in place means the
    verb scan sees it and refuses, which is the safe direction.
    """
    return _SQL_LITERAL_RE.sub("''", sql or "")


def is_safe_to_execute(sql_text: str) -> tuple:
    """May this statement run for real under EXPLAIN ANALYZE?

    Returns (safe, reason). A CTE that merely *starts* with WITH is not
    enough — `WITH x AS (DELETE ... RETURNING *) SELECT * FROM x` is a write
    wearing a SELECT's clothes, which is why the write-verb scan runs over the
    whole statement and not just its first word.
    """
    s = (sql_text or "").strip().rstrip(";")
    if not s:
        return False, "Empty statement."
    if not _READ_START_RE.match(s):
        return False, "Only a SELECT (optionally with a leading WITH) may be executed for real."
    # Scan the statement's *code*, not its data: WHERE name LIKE '%create%' is
    # a perfectly safe read, and would otherwise be refused for containing the
    # word CREATE. Literals are blanked rather than removed so nothing else
    # about the statement's shape changes.
    if _WRITE_VERB_RE.search(_blank_literals(s)):
        return False, (
            "The statement contains a data- or schema-changing keyword. "
            "EXPLAIN ANALYZE would execute it for real, so it was refused."
        )
    return True, ""


def is_explainable(sql_text: str) -> tuple:
    """May this statement be planned at all? Plain EXPLAIN executes nothing."""
    s = (sql_text or "").strip().rstrip(";")
    if not s:
        return False, "No SQL statement was supplied."
    if not _EXPLAINABLE_RE.match(s):
        first = s.split(None, 1)[0].upper() if s.split() else "?"
        return False, (
            f"PostgreSQL cannot EXPLAIN a {first} statement. "
            "Only queries and DML can be planned."
        )
    return True, ""


# ═════════════════════════════════════════════════════════════════════════════
#  EXPLAIN
# ═════════════════════════════════════════════════════════════════════════════

# pg_stat_statements stores the normalised form, with every literal replaced by
# $1, $2… Those are not bindable here (the planner has no parameter values), so
# they become NULL. That is why an estimated plan's row counts can differ from
# the real query's: the note is surfaced to the user rather than hidden.
_PARAM_RE = re.compile(r"\$\d+")
_LEADING_EXPLAIN_RE = re.compile(r"^EXPLAIN\s*(?:\(\s*[^)]*\))?\s*", re.IGNORECASE | re.DOTALL)


def _strip_explain_prefix(sql: str) -> str:
    """A query captured from pg_stat_statements may already BE an EXPLAIN —
    ActMon's own plan probes show up there. Explaining an EXPLAIN is a no-op
    that returns nothing useful, so the prefix comes off first."""
    s = (sql or "").strip().rstrip(";")
    inner = _LEADING_EXPLAIN_RE.sub("", s).strip()
    return inner or s


def _candidate_databases(rec, engine, sql_text: str, preferred: Optional[str]) -> list:
    """Which databases this statement might actually belong to.

    pg_stat_statements is cluster-wide but a connection is per-database, so a
    query recorded against another database cannot be planned on this
    connection. pg_stat_statements knows which dbid it came from; that lookup
    is what turns "relation does not exist" into a plan.
    """
    out = []
    if preferred:
        out.append(preferred)

    try:
        prefix = (sql_text or "").strip()[:80].replace("%", "%%")
        with engine.connect() as conn:
            rows = conn.execute(text(
                "SELECT DISTINCT d.datname FROM pg_stat_statements s "
                "JOIN pg_database d ON d.oid = s.dbid "
                "WHERE s.query LIKE :prefix ORDER BY d.datname LIMIT 5"
            ), {"prefix": prefix + "%"}).fetchall()
            for r in rows:
                if r[0] not in out:
                    out.append(r[0])
    except Exception:
        # pg_stat_statements may not be installed. Not fatal — the default
        # database below is still tried.
        pass

    default_db = rec.database_name or "postgres"
    if default_db not in out:
        out.append(default_db)
    return out


def explain_query(conn_id: int, sql_text: str, db_name: Optional[str], db: Session,
                  mode: str = "estimate") -> dict:
    """Plan one statement.

    mode='estimate' (the default) runs `EXPLAIN (FORMAT JSON)`, which computes a
    plan and executes nothing. mode='analyze' runs `EXPLAIN (ANALYZE, BUFFERS)`,
    which really runs the query, and is refused unless `is_safe_to_execute`
    agrees — in which case the estimated plan is returned instead, with the
    refusal reason attached so the UI can say why.
    """
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": "Connection not found."}

    raw_sql = _strip_explain_prefix(sql_text)
    ok, why = is_explainable(raw_sql)
    if not ok:
        return {"status": "error", "error": why}

    had_params = bool(_PARAM_RE.search(raw_sql))
    planned_sql = _PARAM_RE.sub("NULL", raw_sql)

    declined = ""
    want_analyze = mode == "analyze"
    if want_analyze:
        safe, reason = is_safe_to_execute(raw_sql)
        if not safe:
            want_analyze, declined = False, reason

    try:
        base_engine = _pg_engine(rec)
    except Exception as e:
        return {"status": "error", "error": f"Could not open a connection: {e}"}

    default_db = rec.database_name or "postgres"
    candidates = _candidate_databases(rec, base_engine, raw_sql, db_name)

    plan_json, used_db, analyzed, last_err = None, None, False, ""

    for candidate in candidates:
        eng = base_engine if candidate == default_db else _pg_engine_db(rec, candidate)
        opts = "ANALYZE, BUFFERS, FORMAT JSON" if want_analyze else "FORMAT JSON"
        try:
            with eng.connect() as conn:
                # One statement, not two: on an agent-routed connection every
                # execute() is its own round trip that commits on return, so a
                # SET LOCAL sent separately would have expired before the
                # EXPLAIN arrived — and the cap would silently not apply.
                row = conn.execute(text(
                    f"SET LOCAL statement_timeout = '{_STATEMENT_TIMEOUT}'; "
                    f"EXPLAIN ({opts}) {planned_sql}"
                )).fetchone()
            plan_json, used_db, analyzed = row[0], candidate, want_analyze
            break
        except Exception as e:
            last_err = str(e)

    if plan_json is None:
        tried = ", ".join(f"'{c}'" for c in candidates)
        return {
            "status": "error",
            "error": _explain_failure_message(last_err, tried),
            "detail": _clean_db_error(last_err),
            "tried_databases": candidates,
        }

    try:
        if isinstance(plan_json, str):
            plan_json = json.loads(plan_json)
        top = plan_json[0] if isinstance(plan_json, list) else plan_json
        plan_node = top.get("Plan", top)
        nodes = _flatten_plan(plan_node)
    except Exception as e:
        return {"status": "error", "error": f"The plan could not be parsed: {str(e)[:200]}"}

    return {
        "status": "success",
        "mode": "analyze" if analyzed else "estimate",
        "analyzed": analyzed,
        "analyze_declined_reason": declined,
        "params_replaced": had_params,
        "planning_time": top.get("Planning Time"),
        "execution_time": top.get("Execution Time"),
        "nodes": nodes,
        "raw": plan_json,
        "used_db": used_db,
        "inner_sql": planned_sql,
        "relations": sorted({n["relation"] for n in nodes if n.get("relation")}),
    }


def _clean_db_error(err: str) -> str:
    """The server's message, with anything resembling a DSN removed.

    A failed connection attempt can put host, port and user into the exception
    text; none of that belongs in a browser response.
    """
    s = (err or "").strip()
    s = re.sub(r"postgresql(\+\w+)?://[^\s)\"']+", "[connection]", s, flags=re.IGNORECASE)
    s = re.sub(r"password=\S+", "password=[redacted]", s, flags=re.IGNORECASE)
    for marker in ("\n[SQL:", "\n(Background on this error"):
        if marker in s:
            s = s.split(marker)[0]
    return s.strip()[:400]


def _explain_failure_message(err: str, tried: str) -> str:
    # Classify the SERVER's message only. SQLAlchemy appends the statement it
    # tried as "[SQL: …]", and that echo contains our own
    # `SET LOCAL statement_timeout` — so matching the raw text for "timeout"
    # reported every syntax error as a timeout. _clean_db_error drops the echo.
    low = _clean_db_error(err).lower()

    if "syntax error" in low:
        return ("PostgreSQL could not parse the statement. If it came from pg_stat_statements it may "
                "have been truncated by track_activity_query_size, in which case the full text is not "
                "recoverable and this query cannot be planned.")
    # Connection failures are checked first and deliberately: "connection to
    # server … failed: timeout expired" also contains the word "timeout", and
    # reporting an unreachable host as "planning took too long, the server is
    # busy" sends the reader looking at the wrong machine entirely.
    if "connection to server" in low or "could not connect" in low or "connection refused" in low:
        return ("The PostgreSQL server could not be reached, so nothing could be planned. "
                "Check that the host is up and reachable from ActMon, and that the connection's "
                "host, port and credentials are still correct.")
    if "password authentication failed" in low or "no pg_hba.conf entry" in low:
        return ("PostgreSQL refused the connection's credentials. Update the connection's "
                "username or password, or add a pg_hba.conf rule permitting it.")
    if "database" in low and "does not exist" in low and "relation" not in low:
        return (f"None of the databases tried ({tried}) exist on this server. "
                "Set the connection's Database field to one that does.")
    if "does not exist" in low and "relation" in low:
        return (
            f"The tables this query reads were not found in any database that could be tried ({tried}). "
            "The statement most likely runs in a different database, or the objects have been dropped "
            "since it was recorded. Set the connection's Database field to the one this query runs in."
        )
    if "permission denied" in low:
        return ("The monitoring user is not allowed to read one of the tables in this query, "
                "so PostgreSQL refused to plan it. Grant SELECT on those tables to analyse it.")
    if "canceling statement due to statement timeout" in low:
        return (f"The statement was cancelled after {_STATEMENT_TIMEOUT}. Under EXPLAIN ANALYZE that "
                "means the query itself ran too long; under a plain EXPLAIN it means planning did.")
    if "could not determine data type" in low or "could not determine polymorphic" in low:
        return ("The statement is the normalised form from pg_stat_statements, where literals are "
                "replaced by $1, $2… PostgreSQL could not infer a type for one of them, so the plan "
                "could not be built. Analysing the statement with real literal values will work.")
    if "column" in low and "does not exist" in low:
        return ("A column this query references no longer exists on the table. The statement was "
                "recorded before a schema change, so it can no longer be planned as written. "
                f"PostgreSQL said: {_first_line(low)}")
    # Nothing matched: hand back what the server actually said rather than a
    # vague failure. _clean_db_error has already stripped any DSN or password.
    return (f"EXPLAIN could not run in any of the databases tried ({tried}). "
            f"PostgreSQL said: {_first_line(_clean_db_error(err))}")


def _first_line(s: str) -> str:
    return (s or "").strip().splitlines()[0][:200] if (s or "").strip() else "no detail available."


# ═════════════════════════════════════════════════════════════════════════════
#  Table + index metadata, scoped to this query's own relations
# ═════════════════════════════════════════════════════════════════════════════

_TABLE_META_SQL = """
SELECT c.oid::bigint                                    AS oid,
       n.nspname                                        AS schema_name,
       c.relname                                        AS table_name,
       c.relkind::text                                  AS relkind,
       c.reltuples::bigint                              AS est_rows,
       c.relpages::bigint                               AS pages,
       pg_total_relation_size(c.oid)                    AS total_bytes,
       pg_size_pretty(pg_total_relation_size(c.oid))    AS total_size,
       pg_size_pretty(pg_indexes_size(c.oid))           AS index_size,
       s.seq_scan, s.seq_tup_read, s.idx_scan,
       s.n_live_tup, s.n_dead_tup,
       GREATEST(s.last_analyze, s.last_autoanalyze)     AS last_analyzed
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
 WHERE c.relname = ANY(:names)
   AND c.relkind IN ('r', 'p', 'm', 'f')
   AND n.nspname NOT IN ('pg_catalog', 'information_schema')
"""

_INDEX_META_SQL = """
SELECT i.indrelid::bigint                       AS table_oid,
       ic.relname                               AS index_name,
       i.indisunique                            AS is_unique,
       i.indisprimary                           AS is_primary,
       i.indisvalid                             AS is_valid,
       pg_get_indexdef(i.indexrelid)            AS definition,
       pg_size_pretty(pg_relation_size(i.indexrelid)) AS index_size,
       pg_relation_size(i.indexrelid)           AS index_bytes,
       s.idx_scan,
       ARRAY(
         SELECT pg_get_indexdef(i.indexrelid, k + 1, true)
           FROM generate_subscripts(i.indkey, 1) AS k
          ORDER BY k
       )                                        AS columns
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  LEFT JOIN pg_stat_all_indexes s ON s.indexrelid = i.indexrelid
 WHERE i.indrelid = ANY(:oids)
"""


def collect_table_metadata(conn_id: int, relations: list, db_name: Optional[str],
                           db: Session) -> dict:
    """Real catalogue facts for exactly the relations this query touches.

    Reads only pg_catalog and the pg_stat_* views — no elevated privilege, no
    ANALYZE, nothing written. A relation the monitoring user cannot see simply
    does not come back, and the caller reports less rather than guessing.
    """
    if not relations:
        return {"tables": [], "redundant_indexes": [], "unused_indexes": []}

    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"tables": [], "redundant_indexes": [], "unused_indexes": [], "error": "Connection not found."}

    default_db = rec.database_name or "postgres"
    try:
        engine = _pg_engine(rec) if (not db_name or db_name == default_db) else _pg_engine_db(rec, db_name)
    except Exception as e:
        return {"tables": [], "redundant_indexes": [], "unused_indexes": [],
                "error": f"Could not open a connection: {_clean_db_error(str(e))}"}

    try:
        with engine.connect() as conn:
            trows = conn.execute(text(_TABLE_META_SQL), {"names": list(relations)}).mappings().all()
            tables = [dict(r) for r in trows]
            oids = [t["oid"] for t in tables]
            irows = conn.execute(text(_INDEX_META_SQL), {"oids": oids}).mappings().all() if oids else []
    except Exception as e:
        log.warning("conn=%s table metadata failed: %s", conn_id, e)
        return {"tables": [], "redundant_indexes": [], "unused_indexes": [],
                "error": _clean_db_error(str(e))}

    by_oid = {t["oid"]: t for t in tables}
    for t in tables:
        t["indexes"] = []
        # reltuples is -1 on a relation that has never been analysed; n_live_tup
        # from the stats collector is the better answer when it exists.
        live = t.get("n_live_tup")
        est = t.get("est_rows")
        t["row_estimate"] = int(live if live else (est if est and est > 0 else 0))
        t["never_analyzed"] = t.get("last_analyzed") is None
        if t.get("last_analyzed") is not None:
            t["last_analyzed"] = str(t["last_analyzed"])

    for r in irows:
        idx = dict(r)
        cols = [c for c in (idx.get("columns") or []) if c]
        idx["columns"] = cols
        owner = by_oid.get(idx["table_oid"])
        if owner is not None:
            owner["indexes"].append(idx)

    redundant, unused = [], []
    for t in tables:
        idxs = t["indexes"]
        for a in idxs:
            # An index whose column list is a prefix of another's is redundant:
            # the longer index can serve every lookup the shorter one can.
            # Unique and primary-key indexes are excluded — they enforce a
            # constraint, so dropping them changes semantics, not just speed.
            if a["is_primary"] or a["is_unique"] or not a["columns"]:
                continue
            for b in idxs:
                if b["index_name"] == a["index_name"] or not b["columns"]:
                    continue
                if len(b["columns"]) > len(a["columns"]) and b["columns"][:len(a["columns"])] == a["columns"]:
                    redundant.append({
                        "table": f'{t["schema_name"]}.{t["table_name"]}',
                        "index": a["index_name"],
                        "covered_by": b["index_name"],
                        "columns": a["columns"],
                        "size": a["index_size"],
                    })
                    break
        for i in idxs:
            if not i["is_primary"] and not i["is_unique"] and (i.get("idx_scan") or 0) == 0:
                unused.append({
                    "table": f'{t["schema_name"]}.{t["table_name"]}',
                    "index": i["index_name"],
                    "size": i["index_size"],
                    "columns": i["columns"],
                })

    return {"tables": tables, "redundant_indexes": redundant, "unused_indexes": unused}


# ═════════════════════════════════════════════════════════════════════════════
#  Query-vs-index coverage
# ═════════════════════════════════════════════════════════════════════════════

def _index_leading_columns(table: dict) -> dict:
    """index name -> its leading column, lowercased and stripped of any
    expression wrapper. Only the leading column decides whether a B-tree can
    be used for an equality or range predicate."""
    out = {}
    for idx in table.get("indexes", []):
        cols = idx.get("columns") or []
        if cols:
            out[idx["index_name"]] = cols[0].strip().strip('"').lower()
    return out


def validate_index_coverage(sql_text: str, tables_meta: list) -> tuple:
    """Which predicate columns have an index that could actually serve them.

    This is the check that stops the analysis claiming "add an index" for a
    column that already has one. It reports a finding only when a column is
    filtered or joined on AND no index on that table leads with it.
    """
    predicates = _extract_predicate_columns(sql_text)
    findings = []

    # Only WHERE and JOIN columns drive a missing-index finding. ORDER BY and
    # GROUP BY can benefit from an index too, but recommending one for them
    # without knowing the result size produces far more noise than signal, so
    # they are collected for display and not turned into advice here.
    wanted = set()
    for bucket in ("where_columns", "join_columns"):
        for col in predicates.get(bucket, []) or []:
            # `t.col` -> `col`: the plan names relations, not aliases, so the
            # table half of a qualified name cannot be matched reliably and
            # the column alone is what gets checked.
            wanted.add(col.split(".")[-1].strip().lower())

    for t in tables_meta:
        qualified = f'{t["schema_name"]}.{t["table_name"]}'
        leading = _index_leading_columns(t)
        indexed_cols = set(leading.values())
        all_index_cols = {
            c.strip().strip('"').lower()
            for idx in t.get("indexes", []) for c in (idx.get("columns") or [])
        }

        if t["row_estimate"] < _SMALL_TABLE_ROWS:
            # Too small for an index to be worth anything; saying otherwise
            # would be advice the planner will correctly ignore.
            continue

        for col in sorted(wanted):
            if col in indexed_cols:
                continue
            findings.append({
                "table": qualified,
                "column": col,
                "kind": "no_leading_index",
                "covered_elsewhere": col in all_index_cols,
                "table_rows": t["row_estimate"],
                "detail": (
                    f"'{col}' appears in this query's filters or joins. "
                    + (f"It is present in an index on {qualified}, but not as the leading column, "
                       "so a B-tree cannot use that index for a lookup on it alone."
                       if col in all_index_cols else
                       f"No index on {qualified} leads with it.")
                ),
            })

    return findings, predicates


# ═════════════════════════════════════════════════════════════════════════════
#  Diagnosis — deterministic, evidence-bearing
# ═════════════════════════════════════════════════════════════════════════════

_SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def diagnose(explain_result: dict, coverage: list, predicates: dict,
             tables_meta: list, metrics: dict, sql_text: str) -> dict:
    """Turn the plan, the catalogue and the statistics into findings.

    Every finding carries its own evidence string — the exact number or plan
    line it came from — because a recommendation a DBA cannot verify is a
    recommendation they cannot act on.
    """
    findings = []
    nodes = explain_result.get("nodes") or []
    analyzed = explain_result.get("analyzed")
    by_name = {f'{t["schema_name"]}.{t["table_name"]}': t for t in tables_meta}
    short = {t["table_name"]: t for t in tables_meta}

    def add(severity, kind, title, detail, evidence, action="", table=None, sql=None, tradeoff=""):
        findings.append({
            "severity": severity, "kind": kind, "title": title, "detail": detail,
            "evidence": evidence, "action": action, "table": table,
            "suggested_sql": sql, "tradeoff": tradeoff,
        })

    # ── plan-shape findings ──────────────────────────────────────────────────
    seen_sort_spill = False
    for n in nodes:
        nt = n.get("node_type") or ""
        rel = n.get("relation") or n.get("alias")
        rows = (n.get("actual_rows") if analyzed else n.get("plan_rows")) or 0
        meta = short.get(rel) if rel else None
        table_rows = meta["row_estimate"] if meta else None

        if "Seq Scan" in nt and rel:
            # A sequential scan is only a problem when the table is big enough
            # for an index to beat it. On a small table the planner is right.
            if table_rows is not None and table_rows < _SMALL_TABLE_ROWS:
                continue
            if rows >= _SEQ_SCAN_ROW_FLOOR or (table_rows or 0) >= _SEQ_SCAN_ROW_FLOOR:
                has_filter = bool(n.get("filter"))
                add(
                    "critical" if rows > 100_000 else "high",
                    "SEQ_SCAN",
                    f"Sequential scan on {rel}",
                    "PostgreSQL read the whole table rather than using an index."
                    + (" There is a filter on the scan, so an index on the filtered column could "
                       "replace it." if has_filter else
                       " There is no filter on the scan — the query asks for every row, so an index "
                       "would not help; reducing what the query selects would."),
                    f"{'Actual' if analyzed else 'Estimated'} rows: {rows:,}"
                    + (f" · table holds ~{table_rows:,} rows" if table_rows else "")
                    + (f" · filter: {n['filter']}" if has_filter else ""),
                    action=("Index the columns in the scan's filter." if has_filter
                            else "Narrow the query so it does not need every row."),
                    table=rel,
                )

        if nt.startswith("Sort") and n.get("sort_method"):
            method = n["sort_method"]
            if "disk" in method.lower() and not seen_sort_spill:
                seen_sort_spill = True
                add("high", "SORT_SPILL", "Sort spilled to disk",
                    "The sort did not fit in work_mem, so PostgreSQL wrote it to temporary files. "
                    "Disk sorts are orders of magnitude slower than in-memory ones.",
                    f"Sort Method: {method}" + (f" · Sort Key: {n['sort_key']}" if n.get("sort_key") else ""),
                    action="Raise work_mem for this workload, or add an index matching the ORDER BY "
                           "so the rows arrive already sorted.",
                    tradeoff="work_mem is per sort operation per connection — raising it globally "
                             "multiplies across concurrent queries.")

        if nt == "Nested Loop" and analyzed:
            loops = n.get("actual_loops") or 1
            if loops > 1_000:
                add("high", "NESTED_LOOP", "Nested loop executed many times",
                    "The inner side of this join ran once per outer row. At this loop count a hash "
                    "or merge join is usually far cheaper.",
                    f"Actual loops: {loops:,}",
                    action="Check that the join columns are indexed and that the planner's row "
                           "estimates are accurate — a nested loop is usually chosen because the "
                           "outer side was estimated much smaller than it is.")

        # A planner estimate an order of magnitude off is why it picked the
        # wrong plan. Only observable with ANALYZE.
        if analyzed and n.get("plan_rows") and n.get("actual_rows") is not None:
            est, act = n["plan_rows"], n["actual_rows"]
            if est > 0 and act > 0 and (act / est > 100 or est / act > 100):
                add("medium", "BAD_ESTIMATE", f"Row estimate far off on {nt}",
                    "The planner's row estimate differs from reality by more than 100x. Plan choices "
                    "made on that estimate — join order, join type, scan type — are likely wrong.",
                    f"Estimated {est:,} rows, actually {act:,}",
                    action="Run ANALYZE on the tables involved. If it persists, raise the statistics "
                           "target on the skewed column or add extended statistics.",
                    table=rel)

    # ── catalogue findings ───────────────────────────────────────────────────
    for t in tables_meta:
        qualified = f'{t["schema_name"]}.{t["table_name"]}'
        if t.get("never_analyzed") and t["row_estimate"] >= _SMALL_TABLE_ROWS:
            add("high", "NO_STATS", f"{qualified} has never been analysed",
                "Without statistics the planner is guessing at row counts, which is the most common "
                "cause of a badly chosen plan.",
                f"last_analyze and last_autoanalyze are both null · ~{t['row_estimate']:,} rows",
                action=f"Run ANALYZE {qualified};", table=t["table_name"],
                sql=f"ANALYZE {qualified};")

        dead, live = t.get("n_dead_tup") or 0, t["row_estimate"]
        if live > 0 and dead > 0 and (dead / max(live, 1)) > 0.2 and dead > 1_000:
            add("medium", "BLOAT", f"{qualified} carries many dead rows",
                "Dead tuples are still read by scans until vacuum removes them, so they cost time on "
                "every query against the table.",
                f"{dead:,} dead vs {live:,} live rows ({dead / max(live, 1) * 100:.0f}%)",
                action=f"Run VACUUM {qualified};, and check why autovacuum is not keeping up.",
                table=t["table_name"], sql=f"VACUUM (ANALYZE) {qualified};")

    # ── coverage findings ────────────────────────────────────────────────────
    for c in coverage:
        meta = by_name.get(c["table"])
        cols = [c["column"]]
        idx_name = f'idx_{c["table"].split(".")[-1]}_{c["column"]}'
        add("high" if c["table_rows"] > 50_000 else "medium",
            "MISSING_INDEX",
            f'No index leads with {c["column"]} on {c["table"]}',
            c["detail"],
            f'Table holds ~{c["table_rows"]:,} rows · '
            + (f'existing indexes: {", ".join(i["index_name"] for i in (meta or {}).get("indexes", [])) or "none"}'),
            action="Create an index leading with this column if the filter is selective.",
            table=c["table"],
            sql=f'CREATE INDEX CONCURRENTLY {idx_name} ON {c["table"]} ({", ".join(cols)});',
            tradeoff="Every index slows INSERT/UPDATE/DELETE and uses disk. Create it only if the "
                     "column is selective enough that the planner will choose it.")

    # ── statement-text findings ──────────────────────────────────────────────
    # These three flags come from the shared predicate extractor rather than
    # being re-derived here, so the text analysis is the same on both engines.
    if predicates.get("select_star"):
        add("low", "SELECT_STAR", "The query selects every column",
            "SELECT * moves columns the application may not use, and prevents an index-only scan "
            "because the index can never cover every column.",
            "Statement begins with SELECT *",
            action="List only the columns actually used.")

    if predicates.get("function_wrapped_predicate"):
        add("medium", "FUNCTION_PREDICATE", "A filter wraps its column in a function",
            "A predicate like WHERE lower(email) = … cannot use a plain index on that column: "
            "PostgreSQL would have to evaluate the function for every row first.",
            "Found a function call around a filtered column",
            action="Add an expression index matching the call, e.g. "
                   "CREATE INDEX ... ON t ((lower(email))); — or rewrite the filter so the bare "
                   "column is compared.",
            tradeoff="An expression index only serves that exact expression.")

    if predicates.get("leading_wildcard"):
        add("medium", "LEADING_WILDCARD", "LIKE pattern starts with a wildcard",
            "A B-tree index cannot be used for a pattern that begins with %, so the column is "
            "scanned regardless of what is indexed.",
            "Found LIKE '%…' in the statement",
            action="Use a trigram index (pg_trgm) for substring search, or anchor the pattern.",
            tradeoff="pg_trgm is an extension and its indexes are larger than a B-tree.")

    # ── ratio findings from the statement's own statistics ───────────────────
    rows_returned = metrics.get("rows_returned") or 0
    calls = metrics.get("count_calls") or 0
    avg_ms = metrics.get("avg_exec_ms") or 0
    if calls and rows_returned and calls > 0:
        per_call = rows_returned / calls
        if per_call > 10_000:
            add("medium", "LARGE_RESULT", "The query returns a very large result set",
                "Moving this many rows per call costs time in the server, on the wire and in the "
                "application, whatever the plan looks like.",
                f"{per_call:,.0f} rows per call across {calls:,} calls",
                action="Add a LIMIT, paginate, or aggregate in the database instead of the client.")

    findings.sort(key=lambda f: _SEVERITY_RANK.get(f["severity"], 9))

    worst = findings[0]["severity"] if findings else "low"
    if not findings:
        verdict = "No structural problem was found in this plan."
    else:
        verdict = f'{len(findings)} finding{"" if len(findings) == 1 else "s"}, the most serious being: {findings[0]["title"]}.'

    return {
        "verdict": verdict,
        "worst_severity": worst,
        "findings": findings,
        "counts": {
            s: sum(1 for f in findings if f["severity"] == s)
            for s in ("critical", "high", "medium", "low")
        },
        "metrics_seen": {
            "calls": calls, "avg_exec_ms": avg_ms,
            "rows_returned": rows_returned,
            "analyzed": bool(analyzed),
        },
    }


# ═════════════════════════════════════════════════════════════════════════════
#  Orchestration
# ═════════════════════════════════════════════════════════════════════════════

def analyze_query_full(conn_id: int, sql_text: str, db_name: Optional[str],
                       metrics: dict, db: Session, mode: str = "estimate") -> dict:
    """One pass: plan, metadata, coverage, diagnosis.

    Deliberately no LLM call — this is what runs when the user clicks Analyze,
    so it must return quickly and must not depend on an external service being
    up. The AI pass is a separate endpoint fed this result as evidence.
    """
    explain_result = explain_query(conn_id, sql_text, db_name, db, mode=mode)
    if explain_result.get("status") != "success":
        return explain_result

    relations = explain_result.get("relations") or []
    meta = collect_table_metadata(conn_id, relations, explain_result.get("used_db"), db)
    tables_meta = meta.get("tables", [])

    coverage, predicates = validate_index_coverage(sql_text, tables_meta)
    diagnosis = diagnose(explain_result, coverage, predicates, tables_meta, metrics or {}, sql_text)

    return {
        "status": "success",
        "explain": explain_result,
        "tables": tables_meta,
        "metadata_error": meta.get("error"),
        "redundant_indexes": meta.get("redundant_indexes", []),
        "unused_indexes": meta.get("unused_indexes", []),
        "index_coverage": coverage,
        "predicates": predicates,
        "diagnosis": diagnosis,
    }
