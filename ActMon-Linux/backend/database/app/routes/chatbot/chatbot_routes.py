"""
ActMon AI Chatbot Routes
Folder: Backend/database/app/routes/chatbot/
Purpose: Handle all chatbot API endpoints — streaming chat, context, and report downloads.
"""

import os, json, io, csv
from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.services.auth.tenant_context import tenant_ctx, scope_org_id
from app.services.chatbot.ai_engine import (
    build_system_prompt,
    stream_chat,
    chat_once,
    generate_connections_csv,
    generate_health_summary_csv,
)

router = APIRouter(prefix="/api/v1/chatbot", tags=["ActMon AI Chatbot"])


# ──────────────────────────────────────────────────────────────────────────────
# DB Session
# ──────────────────────────────────────────────────────────────────────────────

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ──────────────────────────────────────────────────────────────────────────────
# Pydantic models
# ──────────────────────────────────────────────────────────────────────────────

class ChatMessageItem(BaseModel):
    role: str          # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    message: str
    history: List[ChatMessageItem] = []
    context: Optional[dict] = None   # {db_type, connection_id, page}


class QuickQueryRequest(BaseModel):
    query_type: str              # create_table | select | index | explain_error
    db_type: str = "postgresql"  # target database dialect
    params: Optional[dict] = {}  # free-form params for the template


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def _conn_list(db: Session, org_id: Optional[int] = None) -> list:
    q = db.query(ConnectionMaster)
    if org_id is not None:
        q = q.filter(ConnectionMaster.org_id == org_id)
    rows = q.all()
    return [
        {
            "id": r.id,
            "connection_name": r.connection_name,
            "db_type": (r.db_type or "unknown").lower(),
            "host": r.host,
            "port": r.port,
            "database_name": r.database_name,
            "environment": r.environment,
        }
        for r in rows
    ]


def _build_messages(system: str, history: List[ChatMessageItem], user_msg: str) -> list:
    msgs = [{"role": "system", "content": system}]
    for h in history[-20:]:   # last 20 turns for context window
        msgs.append({"role": h.role, "content": h.content})
    msgs.append({"role": "user", "content": user_msg})
    return msgs


# ──────────────────────────────────────────────────────────────────────────────
# 1. Streaming chat endpoint (SSE)
# ──────────────────────────────────────────────────────────────────────────────

@router.post("/chat/stream")
async def chat_stream(payload: ChatRequest, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    """
    Main SSE streaming chat. Frontend reads this with fetch + ReadableStream.
    Events: {type:"token", text:"..."} | {type:"done", suggestions:[...], actions:[...]} | {type:"error"}
    """
    connections = _conn_list(db, scope_org_id(ctx))
    system_prompt = build_system_prompt(connections, payload.context or {})
    messages = _build_messages(system_prompt, payload.history, payload.message)

    # ── Live grounding: if the user asks about a node's health/status, fetch its
    #    real-time dashboard data and feed it to the model so it reports actual numbers. ──
    from app.services.chatbot import health_tool
    ctx_conn = None
    if payload.context and payload.context.get("connection_id"):
        ctx_conn = next((c for c in connections if c["id"] == payload.context["connection_id"]), None)
    if health_tool.detect_health_intent(payload.message):
        conn = health_tool.find_connection(db, payload.message, scope_org_id(ctx))
        if conn is None and ctx_conn:  # fall back to the node the user is currently viewing
            conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == ctx_conn["id"]).first()
        if conn is not None:
            live = health_tool.compact(health_tool.get_live_health(db, conn))
            live_block = (
                "You are answering with LIVE REAL-TIME DATA for the requested node — captured just now. "
                "Use ONLY these numbers; never invent values. Do NOT output any SQL, code blocks, or ``` fences. "
                "Reply as a real-time DB HEALTH REPORT in markdown with these sections and nothing else:\n"
                "### Overall Status\n(healthy / degraded / critical — one line)\n"
                "### Key Metrics\n(bullet list using the actual values: uptime, connections, cache hit, slow queries, sizes, replication, etc.)\n"
                "### Concerns\n(anything risky, or 'None')\n"
                "### Recommendations\n(actionable bullets, or 'None — operating normally')\n"
                f"Node: {conn.connection_name} — {(conn.db_type or '').upper()} @ {conn.host}\n"
                f"LIVE DATA JSON:\n{json.dumps(live, default=str)[:6500]}"
            )
            messages.insert(0, {"role": "system", "content": live_block})

    def generate():
        yield from stream_chat(messages)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": "*",
        },
    )


# ──────────────────────────────────────────────────────────────────────────────
# 2. Context — list all connections for the widget selector
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/connections")
def list_connections(db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    """Return this org's configured connections for the chatbot context selector."""
    return {"connections": _conn_list(db, scope_org_id(ctx))}


# ──────────────────────────────────────────────────────────────────────────────
# 3. Report Downloads (CSV)
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/report/connections")
def report_connections(db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    """Download this org's connections as CSV."""
    connections = _conn_list(db, scope_org_id(ctx))
    csv_data = generate_connections_csv(connections)
    return StreamingResponse(
        io.StringIO(csv_data),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=actmon_connections.csv"},
    )


@router.get("/report/health")
def report_health(db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    """Download health summary CSV for this org's connections."""
    connections = _conn_list(db, scope_org_id(ctx))
    csv_data = generate_health_summary_csv(connections)
    return StreamingResponse(
        io.StringIO(csv_data),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=actmon_health_report.csv"},
    )


@router.get("/report/slow-queries/{conn_id}")
def report_slow_queries(conn_id: int, db_type: str = Query("mysql"), db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    """
    Download slow queries CSV for a given connection.
    Fetches from pg_stat_statements (PG) or performance_schema (MySQL).
    """
    q = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id)
    _org = scope_org_id(ctx)
    if _org is not None:
        q = q.filter(ConnectionMaster.org_id == _org)
    rec = q.first()
    if not rec:
        return StreamingResponse(io.StringIO("error,Connection not found"), media_type="text/csv")

    rows = []
    if (rec.db_type or "").lower() in ("postgresql", "pg"):
        try:
            from sqlalchemy import create_engine, text
            from urllib.parse import quote_plus
            pw = quote_plus(rec.password or "")
            engine = create_engine(
                f"postgresql+psycopg2://{rec.username}:{pw}@{rec.host}:{rec.port or 5432}/{rec.database_name or 'postgres'}",
                connect_args={"connect_timeout": 5},
            )
            with engine.connect() as conn:
                result = conn.execute(text(
                    "SELECT query, calls, round(mean_exec_time::numeric, 2) AS mean_ms, "
                    "round(max_exec_time::numeric, 2) AS max_ms, "
                    "round(total_exec_time::numeric, 2) AS total_ms, rows "
                    "FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 100"
                ))
                for r in result:
                    rows.append(dict(r._mapping))
        except Exception as e:
            rows = [{"error": str(e)}]

    elif (rec.db_type or "").lower() in ("mysql", "mariadb"):
        try:
            from sqlalchemy import create_engine, text
            from urllib.parse import quote_plus
            pw = quote_plus(rec.password or "")
            engine = create_engine(
                f"mysql+pymysql://{rec.username}:{pw}@{rec.host}:{rec.port or 3306}/{rec.database_name or ''}",
                connect_args={"connect_timeout": 5},
            )
            with engine.connect() as conn:
                result = conn.execute(text(
                    "SELECT digest_text AS query, count_star AS calls, "
                    "ROUND(avg_timer_wait/1000000000, 2) AS mean_ms, "
                    "ROUND(max_timer_wait/1000000000, 2) AS max_ms, "
                    "ROUND(sum_timer_wait/1000000000, 2) AS total_ms, "
                    "sum_rows_sent AS rows "
                    "FROM performance_schema.events_statements_summary_by_digest "
                    "ORDER BY sum_timer_wait DESC LIMIT 100"
                ))
                for r in result:
                    rows.append(dict(r._mapping))
        except Exception as e:
            rows = [{"error": str(e)}]
    else:
        rows = [{"info": f"Slow query export not supported for {rec.db_type} via this endpoint"}]

    buf = io.StringIO()
    if rows:
        w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    return StreamingResponse(
        io.StringIO(buf.getvalue()),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=slow_queries_conn{conn_id}.csv"},
    )


# ──────────────────────────────────────────────────────────────────────────────
# 4. Quick SQL generator (non-streaming, fast templates)
# ──────────────────────────────────────────────────────────────────────────────

@router.post("/quick-sql")
def quick_sql(payload: QuickQueryRequest):
    """
    Generate SQL for common patterns without going through the full LLM.
    Used by the frontend quick-action buttons.
    """
    db_type = payload.db_type.lower()

    if payload.query_type == "create_table":
        table_name = payload.params.get("table_name", "my_table")
        if db_type in ("mysql", "mariadb"):
            sql = f"""CREATE TABLE `{table_name}` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(255)    NOT NULL,
  `email`      VARCHAR(320)    NOT NULL UNIQUE,
  `status`     ENUM('active','inactive') NOT NULL DEFAULT 'active',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_{table_name}_status` (`status`),
  INDEX `idx_{table_name}_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;"""
        elif db_type in ("mssql", "sqlserver"):
            sql = f"""CREATE TABLE [{table_name}] (
  [id]         BIGINT IDENTITY(1,1) NOT NULL,
  [name]       NVARCHAR(255)  NOT NULL,
  [email]      NVARCHAR(320)  NOT NULL,
  [status]     NVARCHAR(20)   NOT NULL DEFAULT 'active',
  [created_at] DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
  [updated_at] DATETIME2      NOT NULL DEFAULT GETUTCDATE(),
  CONSTRAINT [PK_{table_name}] PRIMARY KEY CLUSTERED ([id] ASC)
);"""
        elif db_type == "oracle":
            sql = f"""CREATE TABLE {table_name.upper()} (
  id         NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name       VARCHAR2(255) NOT NULL,
  email      VARCHAR2(320) NOT NULL UNIQUE,
  status     VARCHAR2(20)  DEFAULT 'active' NOT NULL,
  created_at TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
  updated_at TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL
);"""
        else:  # PostgreSQL default
            sql = f"""CREATE TABLE {table_name} (
  id         BIGSERIAL       PRIMARY KEY,
  name       VARCHAR(255)    NOT NULL,
  email      VARCHAR(320)    NOT NULL UNIQUE,
  status     VARCHAR(20)     NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ     NOT NULL DEFAULT now()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_{table_name}_updated_at
  BEFORE UPDATE ON {table_name}
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();"""

        return {"status": "ok", "sql": sql, "language": db_type}

    return {"status": "error", "error": "Unknown query_type"}


# ──────────────────────────────────────────────────────────────────────────────
# 5. Health check
# ──────────────────────────────────────────────────────────────────────────────

@router.get("/health")
def chatbot_health():
    api_key = os.getenv("GROQ_API_KEY", "")
    return {
        "status": "ok",
        "model": "llama-3.3-70b-versatile",
        "groq_key_set": bool(api_key),
    }
