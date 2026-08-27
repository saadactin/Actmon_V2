"""
Oracle SQL Performance Tuning — deterministic plan-problem detection, plus
Real-Time SQL Monitoring (v$sql_monitor / v$sql_plan_monitor).

`oracle_plan_diagnose()` is a pure function (no DB access) in the same
evidence-based shape as the Storage Health decision engine: every issue
carries real evidence pulled from the plan Oracle already returned, nothing
is flagged just because it exists (a full scan of a tiny table is not an
issue; a step that isn't actually the cost driver isn't a "hotspot").

Real-Time SQL Monitoring requires Oracle Tuning Pack
(CONTROL_MANAGEMENT_PACK_ACCESS=DIAGNOSTIC+TUNING) — every entry point here
checks that FIRST and returns licensed=false rather than attempting (and
confusingly failing) the v$sql_monitor/v$sql_plan_monitor queries when it
isn't enabled.
"""

from sqlalchemy.orm import Session

from app.services.oracle.oracle_monitoring_service import (
    _get_conn_or_404, _get_engine, _rows, _safe_float, _safe_int, _safe_str,
)

_SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}
_HINT_LEVEL = {"critical": "critical", "high": "critical", "medium": "warning", "low": "warning"}
_FULL_SCAN_ROW_FLOOR = 10000
_HOTSPOT_COST_SHARE = 50
_HOTSPOT_MIN_TOTAL_COST = 1000  # a step being "most of a trivially cheap plan" isn't a hotspot
_MISESTIMATE_RATIO = 10


def oracle_plan_diagnose(plan, sql_stats=None, actual_rows_by_step=None, zero_index_tables=None):
    """plan: the list oracle_sql_plan() already builds from v$sql_plan.
    actual_rows_by_step: {plan_id: actual_output_rows} from v$sql_plan_statistics_all,
    only when that view genuinely has rows for this sql_id — never fabricated.
    zero_index_tables: set of (owner, table_name) with zero rows in dba_indexes,
    for the subset of tables this plan actually full-scans (cheap, targeted check)."""
    actual_rows_by_step = actual_rows_by_step or {}
    zero_index_tables = zero_index_tables or set()
    if not plan:
        return {"issues": [], "hints": []}

    root = plan[0] if plan and plan[0].get("id") == 0 else None
    total_cost = (root or {}).get("cost") or max((p.get("cost") or 0) for p in plan) or 0

    issues = []
    for p in plan:
        op = (p.get("operation") or "").upper()
        opt = (p.get("options") or "").upper()
        cost = p.get("cost") or 0
        card = p.get("cardinality") or 0
        cost_share = (cost / total_cost * 100) if total_cost else 0
        obj = f"{p['object_owner']}.{p['object_name']}" if p.get("object_name") else None
        is_full_table_scan = op == "TABLE ACCESS" and "FULL" in opt
        is_cartesian = "CARTESIAN" in opt or "CARTESIAN" in op

        if is_full_table_scan and card >= _FULL_SCAN_ROW_FLOOR:
            sev = "critical" if cost_share >= _HOTSPOT_COST_SHARE else ("high" if card >= 100000 else "medium")
            issues.append({
                "type": "FULL_TABLE_SCAN", "severity": sev, "object": obj,
                "evidence": f"TABLE ACCESS FULL, estimated {card:,} rows, {cost_share:.0f}% of total plan cost",
                "description": f"Full scan reads the entire table — {card:,} rows estimated.",
            })
            key = (p.get("object_owner"), p.get("object_name"))
            if key in zero_index_tables and (p.get("filter_predicates") or p.get("access_predicates")):
                issues.append({
                    "type": "NO_INDEX_ON_TABLE", "severity": "high", "object": obj,
                    "evidence": f"Zero indexes exist on this table; filtered on: {p.get('filter_predicates') or p.get('access_predicates')}",
                    "description": "This table has no indexes at all, so any filtered access must scan it fully.",
                })

        if op == "INDEX" and "FULL SCAN" in opt:
            issues.append({
                "type": "FULL_INDEX_SCAN", "severity": "medium", "object": obj,
                "evidence": f"INDEX FULL SCAN, {cost_share:.0f}% of total plan cost",
                "description": "Scans the entire index rather than seeking into it — sometimes fine for a covering index, still worth checking.",
            })

        if is_cartesian:
            issues.append({
                "type": "CARTESIAN_JOIN", "severity": "critical", "object": obj,
                "evidence": f"{p.get('operation')} {p.get('options') or ''} at plan step {p.get('id')}",
                "description": "A Cartesian join multiplies row counts together with no join condition — almost always unintentional and very expensive.",
            })

        if (total_cost >= _HOTSPOT_MIN_TOTAL_COST and cost_share >= _HOTSPOT_COST_SHARE
                and p.get("id") != 0 and not is_full_table_scan and not is_cartesian):
            issues.append({
                "type": "HIGH_COST_HOTSPOT", "severity": "medium", "object": obj,
                "evidence": f"{p.get('operation')} {p.get('options') or ''} accounts for {cost_share:.0f}% of the total plan cost",
                "description": "This is the step actually dominating the query's cost.",
            })

        step_id = p.get("id")
        if step_id in actual_rows_by_step and card:
            actual = actual_rows_by_step[step_id]
            ratio = (actual / card) if card else None
            if actual and ratio and (ratio > _MISESTIMATE_RATIO or ratio < 1 / _MISESTIMATE_RATIO):
                issues.append({
                    "type": "CARDINALITY_MISESTIMATE", "severity": "high", "object": obj,
                    "evidence": f"Optimizer estimated {card:,} rows, actual was {actual:,} ({ratio:.1f}x off) at step {step_id}",
                    "description": "A misestimate this large usually means stale or missing statistics on this object.",
                })

    issues.sort(key=lambda i: _SEVERITY_RANK.get(i["severity"], 9))
    hints = [
        {
            "level": _HINT_LEVEL.get(i["severity"], "warning"),
            "title": i["type"].replace("_", " ").title(),
            "text": i["description"] + (f" ({i['object']})" if i.get("object") else ""),
            "fix": i["evidence"],
        }
        for i in issues
    ]
    return {"issues": issues, "hints": hints}


def oracle_plan_instability(conn_id: int, db: Session):
    """SQL statements currently holding MORE THAN ONE distinct plan_hash_value
    in the shared pool — Oracle is genuinely flip-flopping plans for the same
    statement right now. License-free (v$sql only), unlike AWR-based plan
    history. sql_text in v$sql is VARCHAR2, not LONG, so MAX() on it is safe —
    no repeat of the ORA-00932 class of issue Storage Health hit."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    unstable = []
    errors = []
    try:
        raw = _rows(engine, """
            SELECT sql_id, COUNT(DISTINCT plan_hash_value) AS plan_count, COUNT(*) AS child_cursors,
                   SUM(executions) AS total_executions, MAX(sql_text) AS sql_text
            FROM v$sql
            GROUP BY sql_id
            HAVING COUNT(DISTINCT plan_hash_value) > 1
            ORDER BY plan_count DESC
            FETCH FIRST 50 ROWS ONLY
        """)
        unstable = [
            {
                "sql_id":           _safe_str(r.get("SQL_ID")),
                "plan_count":       _safe_int(r.get("PLAN_COUNT")),
                "child_cursors":    _safe_int(r.get("CHILD_CURSORS")),
                "total_executions": _safe_int(r.get("TOTAL_EXECUTIONS")),
                "sql_text":         _safe_str(r.get("SQL_TEXT")),
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"plan_instability: {exc}")

    return {"status": "success", "unstable": unstable, "errors": errors}


def _sql_monitor_licensed(engine):
    try:
        raw = _rows(engine, "SELECT value FROM v$parameter WHERE name = 'control_management_pack_access'")
        access = _safe_str(raw[0].get("VALUE")) if raw else ""
    except Exception as exc:
        return False, f"error: {exc}"
    if access.upper() != "DIAGNOSTIC+TUNING":
        return False, access or "unknown"
    return True, access


def oracle_sql_monitor_active(conn_id: int, db: Session):
    conn = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    licensed, access = _sql_monitor_licensed(engine)
    if not licensed:
        return {
            "status": "success", "licensed": False, "executions": [],
            "note": "Real-Time SQL Monitoring requires Oracle Tuning Pack "
                    f"(CONTROL_MANAGEMENT_PACK_ACCESS=DIAGNOSTIC+TUNING). Current value on this instance: {access}.",
        }

    executions = []
    errors = []
    try:
        raw = _rows(engine, """
            SELECT sql_id, sql_exec_id, sql_exec_start, status, sid, session_serial# AS serial_num,
                   username, sql_text, elapsed_time, cpu_time, buffer_gets, disk_reads,
                   px_servers_requested, px_servers_allocated, module, program
            FROM v$sql_monitor
            WHERE status = 'EXECUTING'
               OR (status LIKE 'DONE%' AND sql_exec_start > SYSDATE - 10/1440)
            ORDER BY sql_exec_start DESC
            FETCH FIRST 100 ROWS ONLY
        """)
        executions = [
            {
                "sql_id":        _safe_str(r.get("SQL_ID")),
                "sql_exec_id":   _safe_int(r.get("SQL_EXEC_ID")),
                "sql_exec_start": _safe_str(r.get("SQL_EXEC_START")),
                "status":        _safe_str(r.get("STATUS")),
                "sid":           _safe_int(r.get("SID")),
                "serial":        _safe_int(r.get("SERIAL_NUM")),
                "username":      _safe_str(r.get("USERNAME")),
                "sql_text":      _safe_str(r.get("SQL_TEXT")),
                "elapsed_ms":    round(_safe_float(r.get("ELAPSED_TIME")) / 1000, 1),
                "cpu_ms":        round(_safe_float(r.get("CPU_TIME")) / 1000, 1),
                "buffer_gets":   _safe_int(r.get("BUFFER_GETS")),
                "disk_reads":    _safe_int(r.get("DISK_READS")),
                "px_requested":  _safe_int(r.get("PX_SERVERS_REQUESTED")),
                "px_allocated":  _safe_int(r.get("PX_SERVERS_ALLOCATED")),
                "module":        _safe_str(r.get("MODULE")),
                "program":       _safe_str(r.get("PROGRAM")),
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"sql_monitor: {exc}")

    return {"status": "success", "licensed": True, "executions": executions, "errors": errors}


def oracle_sql_monitor_detail(conn_id: int, db: Session, sql_id: str, sql_exec_id: str):
    conn = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    licensed, access = _sql_monitor_licensed(engine)
    if not licensed:
        return {
            "status": "success", "licensed": False, "steps": [],
            "note": "Real-Time SQL Monitoring requires Oracle Tuning Pack "
                    f"(CONTROL_MANAGEMENT_PACK_ACCESS=DIAGNOSTIC+TUNING). Current value on this instance: {access}.",
        }

    steps = []
    errors = []
    try:
        raw = _rows(
            engine,
            """SELECT plan_line_id, plan_operation, plan_options, plan_object_name, plan_object_type,
                      status, starts, output_rows, cardinality, time_active
               FROM v$sql_plan_monitor
               WHERE sql_id = :sid AND sql_exec_id = :seid
               ORDER BY plan_line_id""",
            {"sid": sql_id, "seid": sql_exec_id},
        )
        steps = [
            {
                "plan_line_id":   _safe_int(r.get("PLAN_LINE_ID")),
                "operation":      _safe_str(r.get("PLAN_OPERATION")),
                "options":        _safe_str(r.get("PLAN_OPTIONS")),
                "object_name":    _safe_str(r.get("PLAN_OBJECT_NAME")),
                "object_type":    _safe_str(r.get("PLAN_OBJECT_TYPE")),
                "status":         _safe_str(r.get("STATUS")),
                "starts":         _safe_int(r.get("STARTS")),
                "output_rows":    _safe_int(r.get("OUTPUT_ROWS")),
                "estimated_rows": _safe_int(r.get("CARDINALITY")),
                "time_active_sec": _safe_int(r.get("TIME_ACTIVE")),
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"sql_plan_monitor: {exc}")

    return {"status": "success", "licensed": True, "sql_id": sql_id, "sql_exec_id": sql_exec_id, "steps": steps, "errors": errors}
