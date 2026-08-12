"""
Alert Rules API  —  /api/v1/alerts/*
=====================================
Dynamic, user-configurable alert threshold rules (Percona-PMM style) plus a
clean read model for the live "active alerts" feed (reuses agent_notifications).

Rule evaluation is data-driven: the monitoring engine reads enabled rules and
raises a notification when a metric crosses its threshold for the configured
duration. This module owns rule CRUD + the active-alert feed/acknowledge.
"""
import json
import re
from typing import Optional, List
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.alert_rule_model import AlertRule
from app.models.agent_model import AgentNotification
from app.models.os_server_model import OsServer
from app.services.alerts.alert_engine_service import (
    applies as _applies, evaluate as _evaluate, infer_metric as _infer_metric, techs_of as _techs,
)
from app.services.common.time_utils import iso_utc

router = APIRouter(prefix="/api/v1/alerts", tags=["Alerts"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ─── schemas ──────────────────────────────────────────────────────────────
class AlertRuleIn(BaseModel):
    name: str
    description: Optional[str] = ""
    metric: str = "cpu"
    operator: str = "gt"
    threshold: float = 0
    scope_type: str = "all"
    scope_value: Optional[str] = None
    severity: str = "warning"
    duration_seconds: int = 60
    cooldown_seconds: int = 600
    enabled: bool = True
    org_id: Optional[int] = 1
    # Which channels to notify on firing — e.g. ["email", "teams"]. Empty
    # means "fall back to the org's severity-based default routing".
    notification_channel_types: List[str] = Field(default_factory=list)
    # Who this rule's email actually goes to — there is no org-wide default
    # any more, so a rule using the "email" channel needs at least one
    # address here or its sends fail with a clear configuration error.
    notification_recipients: List[str] = Field(default_factory=list)
    notification_cc: List[str] = Field(default_factory=list)
    notification_bcc: List[str] = Field(default_factory=list)


class ToggleIn(BaseModel):
    enabled: bool


class AckIn(BaseModel):
    ids: List[int] = Field(default_factory=list)


def _serialize(r: AlertRule) -> dict:
    return {
        "id": r.id,
        "org_id": r.org_id,
        "name": r.name,
        "description": r.description or "",
        "metric": r.metric,
        "operator": r.operator,
        "threshold": r.threshold,
        "scope_type": r.scope_type,
        "scope_value": r.scope_value,
        "severity": r.severity,
        "duration_seconds": r.duration_seconds,
        "cooldown_seconds": r.cooldown_seconds,
        "enabled": r.enabled,
        "notification_channel_types": r.notification_channel_types or [],
        "notification_recipients": r.notification_recipients or [],
        "notification_cc": r.notification_cc or [],
        "notification_bcc": r.notification_bcc or [],
        "created_at": iso_utc(r.created_at),
        "updated_at": iso_utc(r.updated_at),
    }


# Default rules seeded once when the table is empty, so the page is useful
# out of the box (the user can edit / delete / add freely afterwards).
_DEFAULT_RULES = [
    # ── Availability ───────────────────────────────────────────────
    dict(name="Host Offline / Unreachable",        metric="host_down",          operator="eq", threshold=1,  severity="critical", duration_seconds=300, description="The host has stopped responding to monitoring."),
    dict(name="Database Service Down",             metric="service_down",       operator="eq", threshold=1,  severity="critical", duration_seconds=60,  description="The database service (mysqld / postgres / etc.) is not running."),
    dict(name="Database Crash / Unexpected Restart", metric="db_crash",         operator="eq", threshold=1,  severity="critical", duration_seconds=0,   description="The database crashed or restarted unexpectedly."),
    dict(name="Database Not Responding",           metric="db_unreachable",     operator="eq", threshold=1,  severity="critical", duration_seconds=120, description="The database is up but not accepting connections."),
    # ── Host resources ─────────────────────────────────────────────
    dict(name="High CPU (Critical)",               metric="cpu",                operator="gt", threshold=90, severity="critical", duration_seconds=120, description="CPU usage sustained above 90%."),
    dict(name="High CPU (Warning)",                metric="cpu",                operator="gt", threshold=75, severity="warning",  duration_seconds=180, description="CPU usage above 75%."),
    dict(name="High Memory",                       metric="memory",             operator="gt", threshold=90, severity="critical", duration_seconds=120, description="Memory usage above 90%."),
    dict(name="Low Disk Space (Critical)",         metric="disk",               operator="gt", threshold=90, severity="critical", duration_seconds=60,  description="Disk usage above 90% — risk of running out of space."),
    dict(name="Disk Space (Warning)",              metric="disk",               operator="gt", threshold=80, severity="warning",  duration_seconds=120, description="Disk usage above 80%."),
    # ── Connections ────────────────────────────────────────────────
    dict(name="Too Many Connections",             metric="connections_pct",    operator="gt", threshold=90, severity="warning",  duration_seconds=60,  description="Connection usage near the configured maximum."),
    # ── Performance ────────────────────────────────────────────────
    dict(name="Slow Query Spike",                  metric="slow_queries",       operator="gt", threshold=50, severity="warning",  duration_seconds=120, description="High rate of slow queries."),
    dict(name="Low Cache / Buffer Hit Ratio",      metric="cache_hit",          operator="lt", threshold=90, severity="warning",  duration_seconds=300, description="Buffer / cache hit ratio dropped below 90%."),
    dict(name="Deadlocks Detected",                metric="deadlocks",          operator="eq", threshold=1,  severity="warning",  duration_seconds=0,   description="One or more deadlocks were detected."),
    dict(name="Blocking / Locked Sessions",        metric="blocking_sessions",  operator="gt", threshold=5,  severity="warning",  duration_seconds=60,  description="Too many blocked or locked sessions."),
    # ── Replication & HA ───────────────────────────────────────────
    dict(name="Replication Lag High",              metric="replication_lag",    operator="gt", threshold=30, severity="warning",  duration_seconds=60,  description="Replica is lagging behind the primary."),
    dict(name="Replication Stopped / Broken",      metric="replication_broken", operator="eq", threshold=1,  severity="critical", duration_seconds=60,  description="Replication has stopped or broken."),
    # ── Backup ─────────────────────────────────────────────────────
    dict(name="Backup Failed",                     metric="backup_failed",      operator="eq", threshold=1,  severity="critical", duration_seconds=0,   description="A scheduled backup job failed."),
    dict(name="Backup Overdue",                    metric="backup_overdue",     operator="gt", threshold=26, severity="warning",  duration_seconds=0,   description="No successful backup within the expected window."),
    # ── Cloud ──────────────────────────────────────────────────────
    dict(name="Cloud Instance Stopped",            metric="cloud_instance_stopped",  operator="eq", threshold=1,  severity="critical", duration_seconds=0,   description="A cloud instance was stopped or terminated."),
    dict(name="Cloud Resource Unhealthy",          metric="cloud_resource_unhealthy",operator="eq", threshold=1,  severity="critical", duration_seconds=120, description="A cloud resource health check is failing."),
    dict(name="Cloud Cost Over Budget",            metric="cloud_cost_budget",       operator="gt", threshold=90, severity="warning",  duration_seconds=0,   description="Monthly cloud spend is near or over budget."),
]


def _seed_if_empty(db: Session):
    if db.query(AlertRule).count() == 0:
        for d in _DEFAULT_RULES:
            db.add(AlertRule(scope_type="all", cooldown_seconds=600, enabled=True, **d))
        db.commit()


# ─── rule CRUD ────────────────────────────────────────────────────────────
@router.get("/rules", summary="List all alert rules")
def list_rules(org_id: Optional[int] = Query(None), db: Session = Depends(get_db)):
    _seed_if_empty(db)
    q = db.query(AlertRule)
    if org_id is not None:
        q = q.filter(AlertRule.org_id == org_id)
    return [_serialize(r) for r in q.order_by(desc(AlertRule.updated_at)).all()]


@router.post("/rules", summary="Create an alert rule")
def create_rule(payload: AlertRuleIn, db: Session = Depends(get_db)):
    r = AlertRule(**payload.dict())
    db.add(r)
    db.commit()
    db.refresh(r)
    return _serialize(r)


@router.put("/rules/{rule_id}", summary="Update an alert rule")
def update_rule(rule_id: int, payload: AlertRuleIn, db: Session = Depends(get_db)):
    r = db.query(AlertRule).filter(AlertRule.id == rule_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="Alert rule not found")
    for k, v in payload.dict().items():
        setattr(r, k, v)
    r.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(r)
    return _serialize(r)


@router.patch("/rules/{rule_id}/toggle", summary="Enable / disable an alert rule")
def toggle_rule(rule_id: int, payload: ToggleIn, db: Session = Depends(get_db)):
    r = db.query(AlertRule).filter(AlertRule.id == rule_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="Alert rule not found")
    r.enabled = payload.enabled
    r.updated_at = datetime.utcnow()
    db.commit()
    return {"id": rule_id, "enabled": r.enabled}


@router.delete("/rules/{rule_id}", summary="Delete an alert rule")
def delete_rule(rule_id: int, db: Session = Depends(get_db)):
    r = db.query(AlertRule).filter(AlertRule.id == rule_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="Alert rule not found")
    db.delete(r)
    db.commit()
    return {"deleted": rule_id}


# ─── live rule evaluation (active alerts) ─────────────────────────────────
# Active alerts are computed live from the CURRENT server state against the
# ENABLED rules only. Disable a rule → its alerts stop immediately. Only
# metrics we can actually measure fire; the rest simply don't (no false noise).
# The detection logic itself (_applies/_evaluate/_infer_metric) lives in
# services/alerts/alert_engine_service.py, shared with the background
# evaluator that actually triggers notifications — see that module for the
# implementation.


@router.get("/active", summary="Live active alerts (evaluated from enabled rules)")
def active_alerts(db: Session = Depends(get_db)):
    _seed_if_empty(db)
    rules = db.query(AlertRule).filter(AlertRule.enabled.is_(True)).all()
    servers = db.query(OsServer).all()
    now = iso_utc(datetime.utcnow())
    out = []
    for s in servers:
        for r in rules:
            if not _applies(r, s):
                continue
            res = _evaluate(r, s)
            if not res:
                continue
            value, threshold, message = res
            out.append({
                "id": f"{r.id}:{s.id}",
                "rule_id": r.id,
                "rule_name": r.name,
                "severity": (r.severity or "warning").lower(),
                "metric": r.metric,
                "source": s.server_name,
                "technology": techs if (techs := _techs(s)) else None,
                "environment": s.environment,
                "value": value,
                "threshold": threshold,
                "message": message,
                "created_at": now,
            })

    # Include the real collector-generated alerts (agent_notifications) — but ONLY
    # for metrics that have an ENABLED rule. Disable a rule (or all rules) and its
    # alerts stop showing. Exact duplicates (same source + message) are collapsed.
    enabled_metrics = {r.metric for r in rules}
    seen = set()
    notifs = (db.query(AgentNotification)
              .filter(AgentNotification.is_read.is_(False))
              .order_by(desc(AgentNotification.created_at)).limit(300).all())
    for n in notifs:
        metric, label = _infer_metric(n.message or "")
        if metric not in enabled_metrics:
            continue
        key = (n.agent_name, n.message)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "id": f"n{n.id}",
            "rule_id": None,
            "rule_name": label,
            "severity": (n.severity or "info").lower(),
            "metric": metric,
            "source": n.agent_name,
            "technology": None,
            "environment": None,
            "value": None,
            "threshold": None,
            "message": n.message,
            "created_at": iso_utc(n.created_at) or now,
        })

    # latest first (newest alerts at the top)
    out.sort(key=lambda a: (a.get("created_at") or ""), reverse=True)
    return out


# ─── Resolve an alert source → a live DB connection (for real drill-down) ──
@router.get("/drill-context", summary="Resolve alert source to a live DB connection")
def drill_context(source: str = Query(""), metric: str = Query(""), db: Session = Depends(get_db)):
    from app.models.connection_model import ConnectionMaster
    src = (source or "").strip()
    if not src:
        return {"found": False}

    def norm(t):
        t = (t or "").lower()
        return "mysql" if t in ("mariadb",) else t

    # 1) OS server by name / hostname / ip → linked DB instance's connection
    srv = (db.query(OsServer)
             .filter((OsServer.server_name == src) | (OsServer.hostname == src) | (OsServer.ip_address == src))
             .first())
    if srv:
        inst = next((i for i in (srv.db_instances or []) if i.connection_id), None)
        if inst:
            return {"found": True, "conn_id": inst.connection_id, "tech": norm(inst.db_type), "label": srv.server_name}

    # 2) connection by exact name / host
    conn = (db.query(ConnectionMaster)
              .filter((ConnectionMaster.connection_name.ilike(src)) | (ConnectionMaster.host == src))
              .first())
    # 3) fuzzy connection name match (e.g. agent name contains the connection name)
    if not conn:
        conn = db.query(ConnectionMaster).filter(ConnectionMaster.connection_name.ilike(f"%{src}%")).first()
    if conn:
        return {"found": True, "conn_id": conn.id, "tech": norm(conn.db_type), "label": conn.connection_name}

    return {"found": False}


# ─── Step-wise REAL DB diagnostics (execute commands to see why it's spiking) ─
# Read-only diagnostic queries per engine. Each step is executed on demand
# against the live connection and returns real columns + rows.
DIAGNOSTICS = {
    "postgresql": [
        {"id": "pg_active", "title": "Active sessions & waits", "desc": "What is running right now and what it's waiting on.", "metrics": ["cpu", "connections", "slow_queries", "deadlocks"],
         "sql": "SELECT pid, usename, state, wait_event_type, wait_event, EXTRACT(EPOCH FROM (now()-query_start))::int AS running_s, left(query,150) AS query FROM pg_stat_activity WHERE state IS DISTINCT FROM 'idle' AND pid <> pg_backend_pid() ORDER BY query_start NULLS LAST LIMIT 20"},
        {"id": "pg_topsql", "title": "Top queries by total time", "desc": "Heaviest statements (needs pg_stat_statements).", "metrics": ["cpu", "slow_queries"],
         "sql": "SELECT calls, round(total_exec_time)::bigint AS total_ms, round(mean_exec_time,1) AS avg_ms, round(100*total_exec_time/nullif(sum(total_exec_time) over(),0),1) AS pct, left(query,150) AS query FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10"},
        {"id": "pg_cache", "title": "Cache hit ratio", "desc": "Buffer cache effectiveness (low → disk pressure).", "metrics": ["cache_hit", "memory", "cpu"],
         "sql": "SELECT round(sum(blks_hit)*100.0/nullif(sum(blks_hit)+sum(blks_read),0),2) AS cache_hit_pct, sum(blks_read) AS disk_reads, sum(blks_hit) AS cache_hits FROM pg_stat_database"},
        {"id": "pg_conn", "title": "Connections by state", "desc": "Where connections are being spent.", "metrics": ["connections"],
         "sql": "SELECT state, count(*) AS sessions FROM pg_stat_activity GROUP BY state ORDER BY sessions DESC"},
        {"id": "pg_tables", "title": "Largest tables & scan pattern", "desc": "Biggest tables and seq vs index scans.", "metrics": ["disk", "slow_queries"],
         "sql": "SELECT schemaname||'.'||relname AS tbl, pg_size_pretty(pg_total_relation_size(relid)) AS total_size, n_live_tup AS rows, seq_scan, idx_scan FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10"},
    ],
    "mssql": [
        {"id": "ms_bcr", "title": "Buffer cache hit ratio", "desc": "% reads served from memory (low → memory pressure).", "metrics": ["cache_hit", "memory"],
         "sql": "SELECT CAST(a.cntr_value AS FLOAT)/NULLIF(b.cntr_value,0)*100 AS buffer_cache_hit_pct FROM sys.dm_os_performance_counters a JOIN sys.dm_os_performance_counters b ON a.object_name=b.object_name WHERE a.counter_name='Buffer cache hit ratio' AND b.counter_name='Buffer cache hit ratio base'"},
        {"id": "ms_ple", "title": "Page life expectancy", "desc": "Seconds a page stays in memory (low → memory starved).", "metrics": ["cache_hit", "memory"],
         "sql": "SELECT object_name, cntr_value AS page_life_expectancy_s FROM sys.dm_os_performance_counters WHERE counter_name='Page life expectancy'"},
        {"id": "ms_topcpu", "title": "Top queries by CPU", "desc": "Statements consuming the most CPU.", "metrics": ["cpu", "slow_queries"],
         "sql": "SELECT TOP 10 qs.total_worker_time/1000 AS cpu_ms, qs.execution_count AS execs, qs.total_logical_reads AS reads, SUBSTRING(t.text,1,150) AS query FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) t ORDER BY qs.total_worker_time DESC"},
        {"id": "ms_active", "title": "Active requests & waits", "desc": "Live requests, their waits and elapsed time.", "metrics": ["cpu", "connections", "deadlocks"],
         "sql": "SELECT r.session_id, r.status, r.wait_type, r.cpu_time AS cpu_ms, r.total_elapsed_time/1000 AS elapsed_s, SUBSTRING(t.text,1,150) AS query FROM sys.dm_exec_requests r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t WHERE r.session_id>50 ORDER BY r.cpu_time DESC"},
        {"id": "ms_mem", "title": "Top memory clerks", "desc": "What is using SQL Server memory.", "metrics": ["memory", "cache_hit"],
         "sql": "SELECT TOP 10 type, pages_kb/1024 AS mb FROM sys.dm_os_memory_clerks ORDER BY pages_kb DESC"},
        {"id": "ms_tables", "title": "Largest tables", "desc": "Biggest tables by size and rows.", "metrics": ["disk", "slow_queries"],
         "sql": "SELECT TOP 10 t.name AS table_name, MAX(p.rows) AS row_count, SUM(a.total_pages)*8/1024 AS size_mb FROM sys.tables t JOIN sys.indexes i ON t.object_id=i.object_id JOIN sys.partitions p ON i.object_id=p.object_id AND i.index_id=p.index_id JOIN sys.allocation_units a ON p.partition_id=a.container_id GROUP BY t.name ORDER BY size_mb DESC"},
        {"id": "ms_missing", "title": "Missing indexes", "desc": "Indexes SQL Server wishes existed.", "metrics": ["slow_queries", "cpu"],
         "sql": "SELECT TOP 10 CONVERT(int, s.avg_total_user_cost*s.avg_user_impact*(s.user_seeks+s.user_scans)) AS impact, d.statement AS tbl, d.equality_columns, d.inequality_columns, d.included_columns FROM sys.dm_db_missing_index_group_stats s JOIN sys.dm_db_missing_index_groups g ON s.group_handle=g.index_group_handle JOIN sys.dm_db_missing_index_details d ON g.index_handle=d.index_handle ORDER BY impact DESC"},
    ],
    "mysql": [
        {"id": "my_proc", "title": "Active processlist", "desc": "Queries running now (non-sleeping).", "metrics": ["cpu", "connections", "slow_queries"],
         "sql": "SELECT ID, USER, DB, COMMAND, TIME AS time_s, STATE, LEFT(INFO,150) AS query FROM information_schema.PROCESSLIST WHERE COMMAND<>'Sleep' AND INFO IS NOT NULL ORDER BY TIME DESC LIMIT 20"},
        {"id": "my_status", "title": "Key status counters", "desc": "Connections, running threads, slow queries, buffer reads.", "metrics": ["connections", "cache_hit", "slow_queries", "memory"],
         "sql": "SELECT VARIABLE_NAME, VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME IN ('Threads_connected','Threads_running','Slow_queries','Innodb_buffer_pool_reads','Innodb_buffer_pool_read_requests','Aborted_connects','Uptime')"},
        {"id": "my_tables", "title": "Largest tables", "desc": "Biggest tables by size and rows.", "metrics": ["disk", "slow_queries"],
         "sql": "SELECT table_schema, table_name, ROUND((data_length+index_length)/1024/1024) AS size_mb, table_rows FROM information_schema.tables WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY (data_length+index_length) DESC LIMIT 10"},
    ],
}


def _diag_steps(tech):
    return DIAGNOSTICS.get((tech or "").lower(), [])


@router.get("/diagnostics", summary="List real diagnostic steps for an alert")
def list_diagnostics(tech: str = Query(""), metric: str = Query(""), db: Session = Depends(get_db)):
    steps = _diag_steps(tech)
    m = (metric or "").lower()
    # relevant-to-metric steps first, then the rest (stable)
    ordered = [s for s in steps if m in s.get("metrics", [])] + [s for s in steps if m not in s.get("metrics", [])]
    return {"tech": tech, "steps": [{"id": s["id"], "title": s["title"], "desc": s["desc"]} for s in ordered]}


class DiagRunIn(BaseModel):
    conn_id: int
    tech: str
    step_id: str


def _cell(v):
    if v is None or isinstance(v, (int, float, str, bool)):
        return v
    return str(v)


@router.post("/diagnostics/run", summary="Execute one diagnostic step live")
def run_diagnostic(payload: DiagRunIn, db: Session = Depends(get_db)):
    step = next((s for s in _diag_steps(payload.tech) if s["id"] == payload.step_id), None)
    if not step:
        raise HTTPException(status_code=404, detail="Unknown diagnostic step")
    try:
        from sqlalchemy import text
        from app.services import drilldown_service as dd
        conn = dd._get_conn(payload.conn_id, db, payload.tech)
        engine = dd.TECH[(payload.tech or "").lower()]["engine"](conn)
        with engine.connect() as c:
            res = c.execute(text(step["sql"]))
            cols = list(res.keys())
            rows = [[_cell(v) for v in row] for row in res.fetchall()]
        return {"ok": True, "title": step["title"], "columns": cols, "rows": rows, "sql": step["sql"]}
    except Exception as e:
        return {"ok": False, "title": step["title"], "error": str(e)[:400], "sql": step["sql"]}


# ─── Agentic investigation: AI decides the NEXT command from prior output ──
class AgentStepIn(BaseModel):
    conn_id: int
    tech: str
    alert: dict = {}
    history: list = []   # [{title, sql, preview}]


def _is_readonly(sql: str) -> bool:
    s = (sql or "").strip().rstrip(";").lower()
    if not s:
        return False
    if ";" in s:                     # no multiple statements
        return False
    if not (s.startswith("select") or s.startswith("with") or s.startswith("show") or s.startswith("explain")):
        return False
    if s.startswith("explain") and "analyze" in s:   # EXPLAIN plan only — never execute the query
        return False
    banned = (" insert ", " update ", " delete ", " drop ", " alter ", " create ",
              " truncate ", " grant ", " revoke ", " merge ", " call ", "exec ", "execute ",
              "sp_", "xp_cmdshell", "into ")
    padded = f" {s} "
    return not any(b in padded for b in banned)


def _groq_json(messages, max_tokens=900):
    import os
    from groq import Groq
    client = Groq(api_key=os.getenv("GROQ_API_KEY", ""))
    resp = client.chat.completions.create(
        model="llama-3.3-70b-versatile", messages=messages,
        temperature=0.2, max_tokens=max_tokens, response_format={"type": "json_object"},
    )
    return json.loads(resp.choices[0].message.content or "{}")


@router.post("/agent/step", summary="AI decides & runs the next diagnostic command")
def agent_step(payload: AgentStepIn, db: Session = Depends(get_db)):
    tech = (payload.tech or "").lower()
    a = payload.alert or {}
    hist = payload.history or []

    hist_txt = "".join(
        f"\n[{i+1}] {h.get('title','')}\nSQL: {h.get('sql','')}\nOutput:\n{h.get('preview','(none)')}\n"
        for i, h in enumerate(hist)
    ) or "(no commands run yet)"

    sys_msg = {
        "role": "system",
        "content": (
            f"You are ActMon AI, a senior DBA investigating an alert on a {tech} database through a "
            "READ-ONLY SQL terminal. Work like a human expert: based on the alert and the outputs of "
            "previously run commands, decide the SINGLE next diagnostic query that best advances the "
            "investigation. Use ONLY read-only statements valid for this engine (SELECT / WITH / SHOW; "
            "for SQL Server use DMVs like sys.dm_exec_*). Keep queries small (TOP/LIMIT). "
            "For execution plans use EXPLAIN WITHOUT ANALYZE (never EXPLAIN ANALYZE — do not run the query). "
            "When the collected evidence is enough to explain the alert, set done=true and give the "
            "root cause and an ordered solution. Aim to finish within ~6 steps. "
            "In 'reasoning' write 1-2 SHORT plain-English sentences a non-technical person understands: "
            "first briefly say what the PREVIOUS command's output means (skip on the first step), then say "
            "what you will check next and why. Avoid jargon. "
            'Respond ONLY as JSON: {"reasoning":"plain-English: what the last output showed + what we check next",'
            '"title":"short friendly step name","sql":"the next query (empty if done)","done":false,'
            '"root_cause":"(when done, plain English)","solution":["simple fix step",...]}'
        ),
    }
    usr_msg = {
        "role": "user",
        "content": (
            f"ALERT\nSeverity: {a.get('severity')}\nServer: {a.get('source')}\n"
            f"Metric: {a.get('metric')}\nMessage: {a.get('message')}\n\n"
            f"COMMANDS RUN SO FAR:{hist_txt}\n\n"
            "Decide the next read-only diagnostic query, or conclude if you have enough evidence."
        ),
    }

    try:
        data = _groq_json([sys_msg, usr_msg])
    except Exception as e:
        return {"ok": False, "error": f"AI unavailable: {e}"}

    if data.get("done"):
        return {"ok": True, "done": True, "reasoning": data.get("reasoning", ""),
                "root_cause": data.get("root_cause", ""), "solution": data.get("solution", [])}

    sql = (data.get("sql") or "").strip().rstrip(";")
    reasoning = data.get("reasoning", "")
    title = data.get("title", "Diagnostic")
    if not _is_readonly(sql):
        return {"ok": True, "done": False, "reasoning": reasoning, "title": title, "sql": sql,
                "error": "Skipped: proposed statement was not a safe read-only query."}

    try:
        from sqlalchemy import text
        from app.services import drilldown_service as dd
        conn = dd._get_conn(payload.conn_id, db, tech)
        engine = dd.TECH[tech]["engine"](conn)
        with engine.connect() as c:
            res = c.execute(text(sql))
            cols = list(res.keys())[:12]
            rows = [[_cell(v) for v in row][:12] for row in res.fetchall()[:50]]
        return {"ok": True, "done": False, "reasoning": reasoning, "title": title, "sql": sql,
                "columns": cols, "rows": rows}
    except Exception as e:
        return {"ok": True, "done": False, "reasoning": reasoning, "title": title, "sql": sql,
                "error": str(e)[:400]}


# ─── AI analysis (ActMon AI / Groq) ───────────────────────────────────────
class AnalyzeIn(BaseModel):
    message: str
    metric: Optional[str] = ""
    source: Optional[str] = ""
    severity: Optional[str] = "warning"


def _extract_json(text):
    if not text:
        return None
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


@router.post("/analyze", summary="Analyse an alert & suggest fixes (ActMon AI)")
def analyze_alert(payload: AnalyzeIn):
    import os
    sys_msg = {
        "role": "system",
        "content": (
            "You are ActMon AI, a senior database/SRE expert. Investigate the alert like a "
            "top-down DRILL-DOWN: (1) confirm what is happening & why, (2) which slow / top "
            "queries to inspect, (3) which tables / objects are involved, (4) which indexes & "
            "sizing to review — THEN give the root cause and an ordered fix. "
            "Respond ONLY with compact JSON (no markdown), shaped exactly as: "
            '{"summary":"one line","steps":[{"title":"step name","points":["specific thing to check","..."]}],'
            '"root_cause":"the real cause","solution":["fix step 1","fix step 2","..."]}. '
            "Provide 3-4 ordered investigation steps (each 2-4 concrete points), specific to the "
            "metric and database engine. Keep it practical and actionable."
        ),
    }
    usr_msg = {
        "role": "user",
        "content": (
            f"Severity: {payload.severity}\nSource / server: {payload.source}\n"
            f"Metric: {payload.metric}\nAlert message: {payload.message}\n\n"
            "Walk through the investigation step by step (load → slow/top queries → tables → "
            "indexes & size), then give the root cause and an ordered solution."
        ),
    }
    data, raw = {}, ""
    try:
        # Prefer Groq JSON mode → guarantees a valid JSON object with the arrays.
        from groq import Groq
        client = Groq(api_key=os.getenv("GROQ_API_KEY", ""))
        resp = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[sys_msg, usr_msg],
            temperature=0.3,
            max_tokens=1500,
            response_format={"type": "json_object"},
        )
        raw = resp.choices[0].message.content or "{}"
        data = json.loads(raw)
    except Exception:
        # Fallback to the plain (non-JSON-mode) helper.
        try:
            from app.services.chatbot.ai_engine import chat_once
            raw = chat_once([sys_msg, usr_msg])
            data = _extract_json(raw) or {}
        except Exception as e2:
            return {"ok": False, "error": str(e2)}

    return {
        "ok": True,
        "summary": data.get("summary") or (raw[:280] if raw else "No analysis returned."),
        "steps": data.get("steps") or [],
        "root_cause": data.get("root_cause") or data.get("cause") or "",
        "solution": data.get("solution") or data.get("fixes") or [],
    }


@router.post("/active/ack", summary="Acknowledge (mark read) active alerts")
def acknowledge(payload: AckIn, db: Session = Depends(get_db)):
    if payload.ids:
        db.query(AgentNotification).filter(AgentNotification.id.in_(payload.ids)).update(
            {AgentNotification.is_read: True}, synchronize_session=False
        )
    else:
        db.query(AgentNotification).filter(AgentNotification.is_read.is_(False)).update(
            {AgentNotification.is_read: True}, synchronize_session=False
        )
    db.commit()
    return {"acknowledged": payload.ids or "all"}
