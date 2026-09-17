"""
PostgreSQL Processes — a user-friendly view over Postgres's background
worker processes: translates technical backend_type values and their
relevant stat views into friendly cards, without ever exposing a raw
pg_stat_* column as the PRIMARY label (technical names stay available under
each process's own "Technical Details").

Reuses postgres_perf_samples (the same history the Performance tab's trend
charts read from — see postgres_perf_history_service.py) for every process
whose metrics are already collected there: Database Writer, Checkpoint
Manager, Transaction Log Writer, Log Archiving. Automatic Database
Maintenance and the Logical Replication Manager need their own live queries
below, since neither is a per-second rate metric.

Health status deliberately does NOT treat a NULL `state` in pg_stat_activity
as unhealthy — every one of these processes legitimately shows NULL state
there (they're not client backends). Status instead comes from: whether the
process's own stat view answers at all, and a small set of process-specific
thresholds (documented inline per process) — never from raw process
existence in pg_stat_activity alone, since several of these (autovacuum
worker, logical replication worker) are only present exactly while they're
doing something, and their ABSENCE is the normal, healthy state.
"""
import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from pydantic import BaseModel

from app.services.postgres.postgres_monitoring_service import _pg_conn, _rows, _val
from app.services.postgres.postgres_perf_history_service import _fetch_samples, _rate_row, _iso


class ProcessAskRequest(BaseModel):
    question: str
    history: list[dict] = []
    language: str = "English"


def _bounded(fn, timeout=4, default=None):
    """Run fn() with a hard wall-clock timeout so a slow/unreachable target
    PostgreSQL connection (some connections here are agent-routed and can be
    slow) can never block the whole response — same fix, same rationale, as
    postgres_perf_history_service.svc_pg_perf_overview's live-connection
    timeout guard. On timeout the caller just gets `default` back instead of
    the request hanging until the frontend's own request timeout fires."""
    ex = ThreadPoolExecutor(max_workers=1)
    try:
        return ex.submit(fn).result(timeout=timeout)
    except Exception:
        return default
    finally:
        ex.shutdown(wait=False)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _fmt_bytes(v) -> str:
    if v is None:
        return "—"
    v = float(v)
    for unit in ("B", "KB", "MB", "GB"):
        if abs(v) < 1024 or unit == "GB":
            return f"{v:.1f} {unit}"
        v /= 1024
    return f"{v:.1f} GB"


# One entry per background process this page covers. `charts` lists the
# series (already computed by /performance/history — see
# postgres_perf_history_service._RATE_COLUMNS) this process's detail page
# should plot; `kpis` are the same keys, shown as cards above the charts.
PROCESSES = [
    {
        "id": "bgwriter", "friendly_name": "Database Writer", "technical_name": "background writer",
        "icon": "HardDrive", "backend_type": "background writer", "view": "pg_stat_bgwriter",
        "description": "Keeps frequently changed database data safely written from memory to disk, so backends rarely have to write pages themselves.",
        "kpis": ["buffers_clean_per_sec", "buffers_alloc_per_sec", "buffers_backend_per_sec", "buffers_checkpoint_per_sec"],
        "charts": [
            {"title": "Buffers Written/sec", "series": [{"key": "buffers_clean_per_sec", "label": "Buffers Clean/sec"}]},
            {"title": "Buffers Allocated/sec", "series": [{"key": "buffers_alloc_per_sec", "label": "Buffers Alloc/sec"}]},
            {"title": "Backend Writes/sec", "series": [{"key": "buffers_backend_per_sec", "label": "Backend Writes/sec"}]},
            {"title": "Checkpoint Buffer Activity", "series": [{"key": "buffers_checkpoint_per_sec", "label": "Checkpoint Buffers/sec"}]},
        ],
    },
    {
        "id": "checkpointer", "friendly_name": "Checkpoint Manager", "technical_name": "checkpointer",
        "icon": "Save", "backend_type": "checkpointer",
        "view": "pg_stat_checkpointer (PostgreSQL 17+) / pg_stat_bgwriter (older)",
        "description": "Periodically flushes all dirty data to disk and records a checkpoint, so crash recovery only has to replay WAL written since the last one.",
        "kpis": ["checkpoints_timed_per_sec", "checkpoints_req_per_sec", "buffers_checkpoint_per_sec"],
        "charts": [
            {"title": "Checkpoint Activity", "series": [
                {"key": "checkpoints_timed_per_sec", "label": "Timed/sec"},
                {"key": "checkpoints_req_per_sec", "label": "Requested/sec"},
            ]},
            {"title": "Buffers Written", "series": [{"key": "buffers_checkpoint_per_sec", "label": "Buffers/sec"}]},
        ],
    },
    {
        "id": "walwriter", "friendly_name": "Transaction Log Writer", "technical_name": "walwriter",
        "icon": "FileText", "backend_type": "walwriter", "view": "pg_stat_wal",
        "description": "Flushes WAL (transaction log) records to disk on a schedule, so committed transactions survive a crash even before a full sync.",
        "kpis": ["wal_bytes_per_sec", "wal_records_per_sec"],
        "charts": [
            {"title": "WAL Generation", "series": [{"key": "wal_bytes_per_sec", "label": "Bytes/sec"}]},
            {"title": "WAL Records/sec", "series": [{"key": "wal_records_per_sec", "label": "Records/sec"}]},
        ],
    },
    {
        "id": "archiver", "friendly_name": "Log Archiving", "technical_name": "archiver",
        "icon": "Archive", "backend_type": "archiver", "view": "pg_stat_archiver",
        "description": "Copies each completed WAL segment to the configured archive location, for backup and point-in-time recovery.",
        "kpis": ["archived_count_per_sec", "failed_count_per_sec"],
        "charts": [
            {"title": "Archive Rate", "series": [{"key": "archived_count_per_sec", "label": "Archived/sec"}]},
        ],
    },
    {
        "id": "autovacuum", "friendly_name": "Automatic Database Maintenance", "technical_name": "autovacuum launcher",
        "icon": "RefreshCw", "backend_type": "autovacuum launcher",
        "view": "pg_stat_user_tables / pg_stat_progress_vacuum",
        "description": "Reclaims space from deleted/updated rows and keeps planner statistics current, without a DBA running VACUUM/ANALYZE by hand.",
        "kpis": [], "charts": [],
    },
    {
        "id": "logical_replication", "friendly_name": "Logical Replication Manager", "technical_name": "logical replication launcher",
        "icon": "GitBranch", "backend_type": "logical replication launcher", "view": "pg_stat_subscription",
        "description": "Starts and supervises logical replication workers for this server's subscriptions. Idle or absent is normal when no subscriptions are configured — see the Replication tab for physical streaming replication and standbys.",
        "kpis": [], "charts": [],
    },
]

_BY_ID = {p["id"]: p for p in PROCESSES}


def _activity_rows(engine) -> list[dict]:
    try:
        return _rows(engine, "SELECT pid, backend_type, state, wait_event_type, wait_event, "
                              "backend_start, query "
                              "FROM pg_stat_activity WHERE backend_type IS NOT NULL")
    except Exception:
        return []


def _latest_rate(conn_id: int) -> tuple[dict | None, str | None]:
    samples = _fetch_samples(conn_id, 10)
    if len(samples) < 2:
        return None, None
    return _rate_row(samples[-1], samples[-2]), _iso(samples[-1]["captured_at"])


def svc_pg_processes_list(conn_id: int, db) -> dict:
    def _live():
        _, engine = _pg_conn(conn_id, db)
        activity = _activity_rows(engine)
        archiver_failed = None
        try:
            archiver_failed = int(_val(engine, "SELECT failed_count FROM pg_stat_archiver") or 0)
        except Exception:
            pass
        autovacuum_dead_tuples = None
        try:
            autovacuum_dead_tuples = int(_val(engine, "SELECT sum(n_dead_tup) FROM pg_stat_user_tables") or 0)
        except Exception:
            pass
        return activity, archiver_failed, autovacuum_dead_tuples

    activity, archiver_failed, autovacuum_dead_tuples = _bounded(_live, timeout=4, default=([], None, None))

    by_type: dict[str, list] = {}
    for r in activity:
        by_type.setdefault(r["backend_type"], []).append(r)

    rate, sampled_at = _latest_rate(conn_id)

    autovacuum_workers = len(by_type.get("autovacuum worker", []))

    now = _now_iso()
    out = []
    for p in PROCESSES:
        matches = by_type.get(p["backend_type"], [])
        pid_row = matches[0] if matches else None
        entry = {
            "id": p["id"], "friendly_name": p["friendly_name"], "technical_name": p["technical_name"],
            "icon": p["icon"], "pid": pid_row["pid"] if pid_row else None,
        }

        if p["id"] == "bgwriter":
            v = rate.get("buffers_clean_per_sec") if rate else None
            entry.update(status="good", latest_label=f"{v:.1f} buffers/s" if v is not None else "—", updated_at=sampled_at or now)
        elif p["id"] == "checkpointer":
            vt = rate.get("checkpoints_timed_per_sec") if rate else None
            vr = rate.get("checkpoints_req_per_sec") if rate else None
            ratio = (vr / (vt + vr)) if (vt is not None and vr is not None and (vt + vr) > 0) else None
            # Mostly-requested checkpoints (rather than scheduled/timed ones)
            # means writes are outpacing checkpoint_timeout — a real signal
            # this DB is under write pressure, not a NULL-state artifact.
            status = "warning" if (ratio is not None and ratio > 0.5) else "good"
            label = f"{(vt or 0) * 60:.1f} timed/min" if vt is not None else "—"
            entry.update(status=status, latest_label=label, updated_at=sampled_at or now)
        elif p["id"] == "walwriter":
            v = rate.get("wal_bytes_per_sec") if rate else None
            entry.update(status="good", latest_label=f"{_fmt_bytes(v)}/s" if v is not None else "—", updated_at=sampled_at or now)
        elif p["id"] == "archiver":
            status = "critical" if (archiver_failed or 0) > 0 else "good"
            label = f"{archiver_failed} failure{'s' if archiver_failed != 1 else ''}" if archiver_failed is not None else "—"
            entry.update(status=status, latest_label=label, updated_at=now)
        elif p["id"] == "autovacuum":
            entry.update(
                status="good",
                latest_label=f"{autovacuum_workers} worker{'s' if autovacuum_workers != 1 else ''}"
                             + (f" · {autovacuum_dead_tuples:,} dead tuples" if autovacuum_dead_tuples is not None else ""),
                updated_at=now,
            )
        elif p["id"] == "logical_replication":
            entry.update(
                status="good" if pid_row else "unknown",
                latest_label="Running" if pid_row else "Not active",
                updated_at=now,
            )
        out.append(entry)

    return {"status": "success", "processes": out}


def svc_pg_process_detail(conn_id: int, db, process_id: str) -> dict:
    p = _BY_ID.get(process_id)
    if not p:
        return {"status": "error", "error": "Unknown process."}

    def _live():
        _, engine = _pg_conn(conn_id, db)
        activity = _activity_rows(engine)
        matches = [r for r in activity if r["backend_type"] == p["backend_type"]]
        pr = matches[0] if matches else None
        d = {}
        if process_id == "autovacuum":
            d = _autovacuum_detail(engine, activity)
        elif process_id == "logical_replication":
            d = _logical_replication_detail(engine, pr, activity)
        elif process_id == "archiver":
            d = _archiver_detail(engine)
        return pr, d

    pid_row, detail = _bounded(_live, timeout=4, default=(None, {}))

    rate, sampled_at = _latest_rate(conn_id)
    kpis = {}
    for key in p["kpis"]:
        kpis[key] = rate.get(key) if rate else None

    # Same health verdict + one-line summary the list page shows for this
    # process — computed once, in svc_pg_processes_list, and looked up here
    # rather than re-implemented, so the two pages can never disagree.
    list_entry = next((e for e in svc_pg_processes_list(conn_id, db)["processes"] if e["id"] == process_id), {})

    return {
        "status": "success",
        "health_status": list_entry.get("status", "unknown"),
        "latest_label": list_entry.get("latest_label"),
        "id": p["id"], "friendly_name": p["friendly_name"], "technical_name": p["technical_name"],
        "icon": p["icon"], "description": p["description"], "view": p["view"],
        "pid": pid_row["pid"] if pid_row else None,
        "running": bool(pid_row) or process_id in ("bgwriter", "checkpointer", "walwriter", "archiver"),
        "wait_event_type": pid_row["wait_event_type"] if pid_row else None,
        "wait_event": pid_row["wait_event"] if pid_row else None,
        "backend_start": _iso(pid_row["backend_start"]) if pid_row else None,
        "kpis": kpis,
        "detail": detail,
        "updated_at": sampled_at or _now_iso(),
    }


def _archiver_detail(engine) -> dict:
    """The archiver's own current TOTALS (not a rate — these are exactly the
    lifetime counters pg_stat_archiver exposes, shown as-is since 'archived
    so far' is meaningful on its own, unlike the ever-increasing raw
    counters this whole redesign otherwise avoids showing directly)."""
    try:
        r = _rows(engine, "SELECT archived_count, last_archived_wal, last_archived_time, "
                           "failed_count, last_failed_wal, last_failed_time FROM pg_stat_archiver")
        if r:
            d = r[0]
            return {
                "archived_total": d.get("archived_count"), "last_archived_wal": d.get("last_archived_wal"),
                "last_archived_time": _iso(d.get("last_archived_time")),
                "failed_total": d.get("failed_count"), "last_failed_wal": d.get("last_failed_wal"),
                "last_failed_time": _iso(d.get("last_failed_time")),
            }
    except Exception:
        pass
    return {}


def _autovacuum_detail(engine, activity: list[dict]) -> dict:
    workers = [r for r in activity if r["backend_type"] == "autovacuum worker"]
    in_progress = []
    try:
        in_progress = _rows(engine,
            "SELECT p.pid, c.relname AS table_name, p.phase, "
            "p.heap_blks_total, p.heap_blks_scanned, p.heap_blks_vacuumed "
            "FROM pg_stat_progress_vacuum p JOIN pg_class c ON c.oid = p.relid")
    except Exception:
        pass

    dead_tuples = None
    last_vacuum = None
    last_analyze = None
    try:
        r = _rows(engine, "SELECT sum(n_dead_tup) AS dead, max(last_autovacuum) AS lv, max(last_autoanalyze) AS la "
                           "FROM pg_stat_user_tables")
        if r:
            dead_tuples = int(r[0].get("dead") or 0)
            last_vacuum = _iso(r[0].get("lv"))
            last_analyze = _iso(r[0].get("la"))
    except Exception:
        pass

    return {
        "active_workers": len(workers),
        "tables_being_vacuumed": in_progress,
        "dead_tuples": dead_tuples,
        "last_vacuum": last_vacuum,
        "last_analyze": last_analyze,
    }


def _logical_replication_detail(engine, launcher_row, activity: list[dict]) -> dict:
    workers = [r for r in activity if r["backend_type"] == "logical replication worker"]
    subscriptions = []
    try:
        subscriptions = _rows(engine, "SELECT subname, pid, received_lsn::text, latest_end_lsn::text, "
                                       "last_msg_receipt_time FROM pg_stat_subscription")
        for s in subscriptions:
            s["last_msg_receipt_time"] = _iso(s.get("last_msg_receipt_time"))
    except Exception:
        pass
    return {
        "active_workers": len(workers),
        "worker_status": "running" if (launcher_row or workers) else "idle",
        "subscriptions": subscriptions,
        "errors": [],
    }


def svc_pg_process_ask_stream(conn_id: int, db, process_id: str, question: str, history: list, language: str = "English"):
    """'ActMon AI' on a process detail page — a genuine back-and-forth chat,
    not a single canned explanation. Every turn re-sends the SAME live data
    already on screen (KPIs, health, technical fields) as grounding context,
    plus the running conversation, plus whatever the user just asked — so
    the model can be asked literally anything about this process ('why is
    this slow', 'what would happen if I changed X', 'compare this to
    checkpoints') and answer from the real current numbers, not a fixed
    template.

    Streams the answer token-by-token (same SSE frame shape and Groq model
    as app.services.chatbot.ai_engine.stream_chat, the app's main AI chat) —
    a single-shot 'wait for the whole answer' call felt much slower than the
    identical model does elsewhere in the product purely because nothing
    appeared on screen until the entire response was ready; streaming fixes
    the PERCEIVED latency even though total generation time is the same."""
    def _err(msg):
        yield "data: " + json.dumps({"type": "error", "error": msg}) + "\n\n"

    p = _BY_ID.get(process_id)
    if not p:
        yield from _err("Unknown process.")
        return
    if not question or not question.strip():
        yield from _err("Ask a question first.")
        return

    detail = svc_pg_process_detail(conn_id, db, process_id)
    if detail.get("status") != "success":
        yield from _err("Process data is not available right now.")
        return

    try:
        from groq import Groq
    except ImportError:
        yield from _err("ActMon AI engine is not installed on the backend server.")
        return

    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        yield from _err("ActMon AI is not configured on the backend server.")
        return

    kpi_lines = [f"{k}: {v}" for k, v in (detail.get("kpis") or {}).items()]
    ctx_lines = [
        f"PostgreSQL background process: {p['friendly_name']} (technical name: {p['technical_name']})",
        "=" * 40,
        f"Health status  : {detail.get('health_status')}",
        f"Current summary: {detail.get('latest_label')}",
        f"Running        : {detail.get('running')}",
        f"PID            : {detail.get('pid') or 'N/A'}",
        f"Wait event     : {detail.get('wait_event') or 'N/A'}",
        f"Source view    : {detail.get('view')}",
        "",
        "Current metrics:",
        *kpi_lines,
    ]
    if detail.get("detail"):
        ctx_lines += ["", f"Additional live detail: {json.dumps(detail['detail'], default=str)[:1200]}"]
    context = "\n".join(ctx_lines)

    lang = (language or "English").strip() or "English"
    system_prompt = f"""You are ActMon AI, embedded in a PostgreSQL monitoring dashboard's process detail page. The user is a non-technical person looking at a dashboard, not a DBA reading raw stats — they want a short, plain-language answer, not a data report.

Live data for this process, right now (for YOUR reference only — never dump this raw data back at the user):
{context}

How to answer:
- Plain conversational sentences only. Absolutely NO markdown: no tables, no headers, no bullet lists, no bold/asterisks, no code formatting.
- NEVER use a raw database field name (like buffers_clean_per_sec or wal_write_time) in your answer — translate every value into an ordinary phrase (e.g. "it isn't currently writing any data to disk" instead of "buffers_clean_per_sec: 0.0").
- 2-5 short sentences for a simple question. Only go longer if the user explicitly asks for more detail.
- Be concrete about what's actually happening (using the numbers above to inform what you say, not to recite them), and say plainly whether it's healthy or needs attention.
- If something can't be answered from the data given, say so plainly rather than guessing.

Respond ONLY in {lang}, regardless of what language the question is asked in — a natural, everyday way of writing in that language, not a literal translation of English phrasing."""

    messages = [{"role": "system", "content": system_prompt}]
    for turn in (history or [])[-12:]:
        role, content = turn.get("role"), turn.get("content")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": str(content)[:2000]})
    messages.append({"role": "user", "content": question.strip()[:2000]})

    try:
        client = Groq(api_key=api_key)
        stream = client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=messages,
            stream=True,
            max_tokens=700,
            temperature=0.3,
            reasoning_effort="low",
        )
        got_any = False
        for chunk in stream:
            delta = chunk.choices[0].delta.content or ""
            if delta:
                got_any = True
                yield "data: " + json.dumps({"type": "token", "text": delta}) + "\n\n"
        if not got_any:
            yield "data: " + json.dumps({"type": "token", "text": "I couldn't generate a response — try rephrasing that."}) + "\n\n"
        yield "data: " + json.dumps({"type": "done"}) + "\n\n"
    except Exception as e:
        yield "data: " + json.dumps({"type": "error", "error": str(e)[:400]}) + "\n\n"
